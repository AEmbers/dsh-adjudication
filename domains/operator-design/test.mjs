/**
 * operator-design — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  deterministic candidate set
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey                  ->  real grouping (not one-per-path)
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  recomputed anchors; ambiguity refused
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * FOUR THINGS THIS FILE REFUSES TO DO
 * -----------------------------------
 * 1. It never asserts a status without asserting the tier. "anchored" alone is
 *    satisfiable by a verifier that guesses; the tier is what says it did not.
 * 2. It never lets P4 and P6 share a prompt. `assert.notEqual(p6.system,
 *    p4.system)` is load-bearing: the contract validators do NOT check it, so
 *    without this assertion a domain could pass `validateDomainPackV2` while
 *    handing its reviewer its own reasoning back.
 * 3. It never fabricates an anchor. Every anchored finding in the coverage
 *    section is produced by `anchor.verify` on real text first — the plugin's
 *    `adjudication_submit` recomputes anchors itself, so an assertion built on a
 *    hand-written `anchored: true` would prove nothing.
 * 4. It never hard-codes "operator-design is the only domain in `domains/`".
 *
 * Usage: `node domains/operator-design/test.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MIN_RULES_PER_DOMAIN,
  MANDATORY_FIXTURES,
  TRUSTED_ANCHOR_TIERS,
  checkContractIntegrity,
  evidenceToolName,
  inputFormatFor,
  validateAnchorVerdict,
  validateDomainPackV2,
  validateEvidenceToolkit,
  validatePromptOutput,
  validateRuleDocument,
} from '../../lib/contracts.js'
import {
  DEFAULT_EXCLUDE_PATTERNS,
  coverage,
  createBudget,
  gate,
  report,
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { createNodeIo, discoverDomains, loadDomain, loadDomains } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack from './index.js'
import source from './source.js'
import anchor from './anchor.js'
import evidence from './evidence.js'
import prompts from './prompts.js'

const here = dirname(fileURLToPath(import.meta.url))

let passes = 0
let failures = 0
const failedTitles = []

function test(title, body) {
  try {
    body()
    passes += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures += 1
    failedTitles.push(title)
    console.log(`  FAIL ${title}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

async function testAsync(title, body) {
  try {
    await body()
    passes += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures += 1
    failedTitles.push(title)
    console.log(`  FAIL ${title}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_FILES = readdirSync(join(here, 'fixtures')).filter((file) => file.endsWith('.json')).sort()
const FIXTURES = new Map()
for (const file of FIXTURE_FILES) {
  const parsed = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
  FIXTURES.set(parsed.name, parsed)
}

const fixture = (name) => {
  const value = FIXTURES.get(name)
  assert.ok(value !== undefined, `missing fixture "${name}"`)
  return value
}

const RULE_FILES = readdirSync(join(here, 'rules')).filter((file) => file.endsWith('.md')).sort()

/**
 * Enumerate + gate one fixture.
 *
 * A fixture may NARROW the pack's gate (`fixture.gate.exclude`); it can never
 * widen it. Widening would let a fixture quietly re-admit a category the pack
 * exists to exclude, which is the opposite of what a boundary fixture is for.
 *
 * ADDED (t23): that narrowing mechanism is for exercising the MECHANISM. It must
 * never be what makes a boundary hold — see `runP1PackOnly` below, which is what
 * the all-gated-out boundary uses.
 */
function runP0P1(name) {
  const value = fixture(name)
  const context = { maxCandidates: 400, maxExcerptLines: 500 }
  const enumerated = source.enumerate(value.input.payload, context)
  const result = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: [...(pack.gate?.exclude ?? []), ...(value.gate?.exclude ?? [])],
    extensions: pack.gate?.extensions ?? null,
  })
  return { enumerated, result }
}

/**
 * Enumerate + gate one fixture with the PACK's gate and nothing else.
 *
 * ADDED (t23). This is the gate that exists in production: through the plugin,
 * the fixture is not consulted at all. A boundary proven with any other gate is
 * a statement about the test harness, not about the pack.
 */
function runP1PackOnly(name) {
  const value = fixture(name)
  const context = { maxCandidates: 400, maxExcerptLines: 500 }
  const enumerated = source.enumerate(value.input.payload, context)
  const result = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: pack.gate?.exclude ?? [],
    extensions: pack.gate?.extensions ?? null,
  })
  return { enumerated, result }
}

const byPredicate = (result) => {
  const map = {}
  for (const item of result.excluded) {
    if (!map[item.predicate]) map[item.predicate] = []
    map[item.predicate].push(item.path)
  }
  for (const key of Object.keys(map)) map[key].sort()
  return map
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\noperator-design domain — contract v2 end-to-end')
console.log('='.repeat(60))
console.log('\n0. the pack itself')

test('the shared contract constants are internally consistent', () => {
  assert.deepEqual(checkContractIntegrity(), [])
})

test('the pack declares no extension point inline — the loader assembles them from siblings', () => {
  for (const field of ['candidateSource', 'anchorVerifier', 'evidenceTools', 'reviewPrompts', 'ruleLibrary']) {
    assert.equal(pack[field], undefined, `${field} must come from its own file, not from index.js`)
  }
})

test('the declared v2 fields the pack alone owns are complete', () => {
  const problems = validateDomainPackV2({
    ...pack,
    candidateSource: source,
    anchorVerifier: anchor,
    evidenceTools: evidence,
    reviewPrompts: prompts,
    ruleLibrary: {
      dir: 'rules',
      rules: RULE_FILES.map((_file, index) => ({ name: `rule-${index}`, match: ['**/*'], text: 'y'.repeat(12), needsExpertReview: true })),
    },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('operator-design')
  assert.equal(declared.format, 'operator-registry-and-tests')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, 'signature-and-tolerance')
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable',
    'this anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('recall-first and triage agree, because one of the two would otherwise be a lie', () => {
  assert.equal(pack.lossOrientation, 'recall-first')
  assert.equal(pack.criticism.kind, 'triage')
})

test('the bundleKey is an object with a resolver, not a bare string strategy', () => {
  // `validateDomainPackV2` rejects a string strategy outside BUNDLE_KEY_STRATEGIES.
  // `operator` is this domain's private name, so it MUST supply `resolve`.
  assert.equal(typeof pack.bundleKey, 'object')
  assert.equal(pack.bundleKey.strategy, 'operator')
  assert.equal(typeof pack.bundleKey.resolve, 'function')
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.ok(evidence.tools.length > 0, 'a toolkit with no tools would be admissible but useless here')
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxLines > 0 && tool.limits.maxItems > 0 && tool.limits.maxCalls > 0,
      `${tool.name} must declare positive limits`)
    assert.equal(typeof tool.execute, 'function')
  }
})

// ---------------------------------------------------------------------------
// P3 — rules
// ---------------------------------------------------------------------------

console.log('\nP3 — the rule library')

test(`rules/ ships at least ${MIN_RULES_PER_DOMAIN} documents`, () => {
  assert.ok(RULE_FILES.length >= MIN_RULES_PER_DOMAIN, `found ${RULE_FILES.length}`)
})

test('every rule document is valid: name / match / text / needs-expert-review', () => {
  const problems = []
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    problems.push(...validateRuleDocument(text, file))
    assert.match(text, /needs-expert-review: true/u, `${file} must state its provenance in front-matter`)
    assert.match(text, /source: agent-drafted/u, `${file} must say who drafted it`)
  }
  assert.deepEqual(problems, [], problems.join('; '))
})

test('no rule document claims expert validation', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    assert.doesNotMatch(text, /expert-validated|已通过专家|专家审定/u, `${file} must not claim expert validation`)
  }
})

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'cuda-only', match: ['**/*.cu'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['src/ops/my_op.cu'])
  assert.deepEqual(selected.injected.map((rule) => rule.name).sort(), ['any', 'cuda-only'])
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  assert.ok(FIXTURES.has('missing-tolerance'), 'the documented fourth fixture for this format')
})

test('every fixture declares anchors with both positive and negative cases', () => {
  for (const [name, value] of FIXTURES) {
    assert.ok(value.anchors, `${name} must declare anchors`)
    assert.ok(value.anchors.positive?.length > 0, `${name} needs a positive anchor case`)
    assert.ok(value.anchors.negative?.length > 0, `${name} needs a negative anchor case`)
  }
})

// ---------------------------------------------------------------------------
// P0 / P1 — the boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — candidate source and gate')

test('P0 declares bounded:true and the contract agrees for this domain', () => {
  assert.equal(source.bounded, true)
  assert.equal(inputFormatFor('operator-design').bounded, true)
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate([], {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ tests: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ operators: [], tests: {} }, {}), /E_INPUT_FORMAT/u)
  // An EMPTY registry is NOT malformed: "nothing to review" is a legitimate answer.
  assert.doesNotThrow(() => source.enumerate({ operators: [], tests: [] }, {}))
})

test('boundary 1 — the empty fixture produces zero candidates, and the gate agrees', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
  assert.equal(fixture('empty').expect.candidates, 0)
})

test('boundary 2 — the PACK\'s own gate drains the all-gated-out fixture', () => {
  const value = fixture('all-gated-out')
  const expectation = value.expect

  // CHANGED (t23). This boundary used to be proven with
  // `[...pack.gate.exclude, ...fixture.gate.exclude]`, and the fixture carried
  // `{exclude: ['**/generated/**']}`. That made the claim circular: it proved
  // "pack ∪ fixture drains the fixture". A boundary has to prove what the PACK
  // alone does, because the fixture's gate does not exist in production — and
  // measured through the real plugin, the generated candidate was admitted.
  //
  // So the fixture no longer carries a gate at all, and the gate below is built
  // from the pack ONLY. The first assertion is what keeps it that way.
  assert.equal(value.gate, undefined, 'the fixture must not be doing the work its own boundary claims')

  const { enumerated, result } = runP1PackOnly('all-gated-out')
  assert.equal(enumerated.candidates.length, expectation.candidates)
  assert.ok(enumerated.candidates.length > 0, 'this fixture must NOT be empty — it is the opposite boundary')
  assert.equal(result.selected.length, 0, 'the PACK alone must exclude every candidate')
  assert.deepEqual(byPredicate(result), expectation.excludedByPredicate,
    'and the reasons must be the pack\'s own — `user-exclude` is the bucket the pack declares')
})

test('the pack\'s own rule — not an engine default — is what excludes the generated candidate', () => {
  const { enumerated, result } = runP1PackOnly('all-gated-out')
  const buckets = new Set(result.excluded.map((item) => item.predicate))
  assert.deepEqual([...buckets].sort(), ['default-path', 'user-exclude'],
    'two buckets exactly: the engine defaults, and the pack\'s own exclude list')
  const generated = result.excluded.find((item) => item.path.startsWith('generated/'))
  assert.ok(generated !== undefined, 'the generated candidate must be excluded')
  assert.equal(generated.predicate, 'user-exclude',
    'the engine\'s defaults do not cover `generated/` — this bucket is the pack\'s own list')

  // SHAPE CONTROL (t23). `user-exclude` is the bucket for the pack's whole exclude
  // list, so the bucket name alone cannot say WHICH pattern did it. Remove the one
  // pattern and check the candidate comes back: that is the only thing here that
  // proves the pack's own rule is load-bearing rather than incidentally redundant.
  const control = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: pack.gate.exclude.filter((pattern) => pattern !== '**/generated/**'),
    extensions: pack.gate?.extensions ?? null,
  })
  assert.deepEqual(control.selected.map((item) => item.path), [generated.path],
    'control: with the pack\'s own rule removed this candidate IS admitted — so the rule is what excludes it')
})

test('boundary 3 — the happy path admits what it claims to admit', () => {
  const { enumerated, result } = runP0P1('happy-path')
  const expectation = fixture('happy-path').expect
  assert.equal(enumerated.candidates.length, expectation.candidates)
  assert.equal(result.selected.length, expectation.admitted)
  assert.deepEqual(result.selected.map((entry) => entry.path).sort(), [...expectation.paths].sort())
  assert.deepEqual(byPredicate(result), expectation.excludedByPredicate)
})

test('a form with a usable tolerance is NOT reported — the negative control for the whole class', () => {
  const { enumerated } = runP0P1('happy-path')
  const reported = enumerated.candidates.map((item) => `${item.meta.operator}|${item.meta.backend}|${item.meta.dtype}|${item.meta.shapeBranch}`)
  assert.equal(reported.includes('my_op|cuda|fp32|contiguous'), false, 'this form has an atol/rtol test')
  assert.equal(reported.includes('fast_scan|cuda|fp32|contiguous'), false)
  assert.equal(reported.includes('fast_scan|cuda|fp64|contiguous'), false)
  assert.deepEqual(reported.sort(), [
    'fast_scan|cpu|fp32|contiguous',
    'fast_scan|cpu|fp64|contiguous',
    'my_op|cuda|bf16|contiguous',
    'my_op|cuda|bf16|strided',
    'my_op|cuda|fp32|strided',
  ])
})

test('"no test at all" and "test with no tolerance" are different findings', () => {
  const { enumerated } = runP0P1('happy-path')
  const byForm = new Map(enumerated.candidates.map((item) => [`${item.meta.dtype}|${item.meta.shapeBranch}`, item.meta.findingKind]))
  assert.equal(byForm.get('fp32|strided'), 'missing-tolerance', 'a test exists; only the tolerance is missing')
  assert.equal(byForm.get('bf16|contiguous'), 'uncovered-form', 'no test exists at all')
  assert.notEqual(byForm.get('fp32|strided'), byForm.get('bf16|contiguous'),
    'collapsing these two would send the reader to the wrong fix')
})

test('the documented fourth fixture isolates the missing-tolerance class', () => {
  const { enumerated, result } = runP0P1('missing-tolerance')
  assert.equal(enumerated.candidates.length, 1)
  assert.equal(enumerated.candidates[0].meta.findingKind, 'missing-tolerance')
  assert.equal(result.selected.length, 1)
})

test('an operator whose file is unknown is reported, not silently given a fake path', () => {
  const enumerated = source.enumerate({
    operators: [{ name: 'ghost', signature: 'void ghost()', backends: ['cuda'], dtypes: ['fp32'], shapeBranches: ['any'] }],
    tests: [],
  }, {})
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(enumerated.excluded.length, 1)
  assert.equal(enumerated.excluded[0].id, 'ghost')
  assert.match(enumerated.excluded[0].reason, /实现文件/u)
})

test('a test naming an operator the registry does not have is reported', () => {
  const enumerated = source.enumerate({
    operators: [{ name: 'known', signature: 'void known()', backends: ['cuda'], dtypes: ['fp32'], shapeBranches: ['any'], path: 'src/known.cu' }],
    tests: [{ operator: 'stranger', backend: 'cuda', dtype: 'fp32', shape: 'any', tolerance: null, asserted: false }],
  }, {})
  assert.ok(enumerated.excluded.some((item) => item.id === 'stranger'))
})

test('a wildcard shape test covers every shape branch of that form', () => {
  const enumerated = source.enumerate({
    operators: [{ name: 'op', signature: 'void op()', backends: ['cuda'], dtypes: ['fp32'], shapeBranches: ['a', 'b'], path: 'src/op.cu', source: 'void op() {' }],
    tests: [{ operator: 'op', backend: 'cuda', dtype: 'fp32', shape: '*', tolerance: { atol: 1e-5 }, asserted: true }],
  }, {})
  assert.deepEqual(enumerated.candidates, [], 'a wildcard test covers both branches')
})

test('candidate ids are unique and `path` stays a gate-globable implementation path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'a synthetic id must never leak into candidate.path')
    assert.ok(candidate.path.endsWith('.cu'), 'the path stays the implementation file')
  }
})

test('a candidate larger than the ceiling is removed by the too-large predicate', () => {
  const result = gate([{ path: 'src/huge.cu', bytes: 4096 }], { extensions: pack.gate.extensions, maxFileBytes: 1024 })
  assert.deepEqual(result.selected, [])
  assert.equal(result.excluded[0].predicate, 'too-large')
})

test('no fixture supplies exclude rules of its own — exclusions must come from the pack', () => {
  // t23, F1. This replaces an assertion that pinned the pack's exclude list to an
  // exact count and content ("restates defaults, plus exactly one of its own").
  // That is the "too tight" mirror of an empty assertion: it can only be green
  // while the list looks exactly as it did, so a CORRECT fix turns it red and the
  // red says nothing about whether the behaviour is right.
  //
  // The property being asserted instead is where the rules come from. A boundary
  // proven with `pack.gate.exclude ∪ fixture.gate.exclude` is a statement about
  // the test harness; the fixture's gate does not exist in production. That is
  // exactly how `**/generated/**` came to be "excluded" while the real gate
  // admitted generated code.
  const offenders = [...FIXTURES]
    .filter(([, value]) => value.gate !== undefined && (value.gate.exclude ?? []).length > 0)
    .map(([name]) => name)
  assert.deepEqual(offenders, [], 'no fixture may declare exclude rules — the rule belongs in the pack')
  for (const [name, value] of FIXTURES) {
    assert.equal(Object.hasOwn(value, 'exclude'), false, `${name} must not carry a top-level exclude`)
  }
})

test('the pack\'s OWN gate reproduces every predicate category the boundary claims', () => {
  // Property, not a count: for each predicate the boundary names, the members must
  // come out of the pack's gate exactly as claimed — and both buckets must be
  // populated by the source they name (engine defaults vs the pack's own list).
  const expectation = fixture('all-gated-out').expect
  const { result } = runP1PackOnly('all-gated-out')
  const got = byPredicate(result)

  assert.deepEqual(Object.keys(got).sort(), Object.keys(expectation.excludedByPredicate).sort(),
    'the predicate categories must be exactly the ones the boundary claims')
  for (const [predicate, paths] of Object.entries(got)) {
    assert.deepEqual(paths, [...expectation.excludedByPredicate[predicate]].sort(), `predicate ${predicate}`)
  }
  // Each bucket must be attributable: the pack's own list is what fills
  // `user-exclude`, and the engine's defaults are what fill `default-path`. An
  // empty bucket would mean one of the two sources silently stopped working.
  assert.ok(got['user-exclude'].length > 0, 'the pack\'s own rules must be doing part of the work')
  assert.ok(got['default-path'].length > 0, 'the engine defaults must still be doing their part')
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling')

test('the operator resolver groups by implementation file, not by form', () => {
  assert.equal(pack.bundleKey.resolve({ path: 'src/ops/my_op.cu' }), 'src/ops/my_op.cu')
  assert.equal(pack.bundleKey.resolve({ path: 'src\\ops\\scan.cu' }), 'src/ops/scan.cu')
  // The resolver must not read anything the engine refuses to forward: index.js
  // `toCandidates()` copies a fixed field set, so a resolver that wanted `meta`
  // would silently see `undefined` — which would put every form in its own bundle.
  assert.equal(pack.bundleKey.resolve({ path: 'src/ops/my_op.cu', meta: { operator: 'WRONG' } }), 'src/ops/my_op.cu')
})

test('all the forms of one operator really land in the same bundle', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: pack.bundleKey.resolve(entry) }))
  const byKey = new Map()
  for (const entry of keyed) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, [])
    byKey.get(entry.key).push(entry)
  }
  assert.deepEqual([...byKey.keys()].sort(), [...fixture('happy-path').expect.bundleKeys].sort())
  assert.equal(byKey.get('src/ops/my_op.cu').length, 3, 'three forms of one operator must share a bundle')
})

// ---------------------------------------------------------------------------
// P5 — the anchor verifier, positive and negative
// ---------------------------------------------------------------------------

console.log('\nP5 — anchors (the hard constraint)')

function verifyFromCase(entry) {
  const verdict = anchor.verify(entry.claim, entry.subject)
  const problems = validateAnchorVerdict(verdict)
  assert.deepEqual(problems, [], `${entry.note}: ${problems.join('; ')}`)
  return verdict
}

for (const [name, value] of FIXTURES) {
  for (const entry of value.anchors.positive ?? []) {
    test(`anchor positive [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, entry.expectStatus, entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      if (entry.expectPath !== undefined) assert.equal(verdict.path, entry.expectPath)
      if (entry.expectStart !== undefined) assert.equal(verdict.start, entry.expectStart)
      if (verdict.status === 'anchored') {
        assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier), `tier "${verdict.tier}" is not trusted`)
      }
    })
  }
  for (const entry of value.anchors.negative ?? []) {
    test(`anchor negative [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, entry.expectStatus, entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.equal(verdict.start, null, 'an unanchored verdict must not carry a line number')
      assert.equal(verdict.path, null)
    })
  }
  for (const entry of value.anchors.ambiguous ?? []) {
    test(`anchor ambiguous [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, 'unanchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.ok(Array.isArray(verdict.ambiguousIn) && verdict.ambiguousIn.length > 1,
        'an ambiguous verdict must list the competing locations')
      if (entry.expectAmbiguousIn !== undefined) {
        assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
      }
      assert.equal(typeof verdict.detail, 'string', 'every unanchored verdict must explain itself')
    })
  }
}

const OPERATORS = [{
  name: 'my_op',
  signature: 'void my_op(const Tensor& x, int axis)',
  backends: ['cuda'],
  dtypes: ['fp32', 'bf16'],
  shapeBranches: ['contiguous', 'strided'],
}]
const KERNEL = '// my_op kernel\nvoid my_op(const Tensor& x, int axis) {\n}'
const CLAIM = (findingKind, overrides = {}) => ({
  kind: 'signature-and-tolerance',
  path: 'src/ops/my_op.cu',
  locator: {
    kind: 'operator-form',
    path: 'src/ops/my_op.cu',
    operator: 'my_op',
    backend: 'cuda',
    dtype: 'bf16',
    shapeBranch: 'contiguous',
    findingKind,
    ...overrides,
  },
  excerpt: 'void my_op(const Tensor& x, int axis) {',
})
const SUBJECT = (overrides = {}) => ({ path: 'src/ops/my_op.cu', content: KERNEL, operators: OPERATORS, tests: [], ...overrides })

test('the form is recomputed from the registry, not merely found in the file', () => {
  // The excerpt IS in the file. A text search would call this anchored. The
  // registry check is what makes it an anchor: the form must be declared.
  const verdict = anchor.verify(CLAIM('uncovered-form'), SUBJECT({ tests: [] }))
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'recomputed-unique')
  assert.deepEqual(verdict.locator, {
    kind: 'operator-form',
    operator: 'my_op',
    backend: 'cuda',
    dtype: 'bf16',
    shapeBranch: 'contiguous',
    findingKind: 'uncovered-form',
  })
})

test('a form the registry does not declare is refused, even though the text is right there', () => {
  const verdict = anchor.verify(CLAIM('uncovered-form', { dtype: 'int8' }), SUBJECT())
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /不声明 dtype "int8"/u)
})

test('a signature that disagrees with the registry is refused', () => {
  const drifted = anchor.verify(
    { ...CLAIM('uncovered-form'), excerpt: 'void my_op(const Tensor& x) {' },
    { path: 'src/ops/my_op.cu', content: 'void my_op(const Tensor& x) {', operators: OPERATORS, tests: [] },
  )
  assert.equal(drifted.status, 'unanchored')
  assert.equal(drifted.tier, 'locator-mismatch')
  assert.match(drifted.detail, /与注册表里 "my_op" 的签名不一致/u)
})

test('"no test manifest" refuses — it must never read as "uncovered"', () => {
  const verdict = anchor.verify(CLAIM('uncovered-form'), { path: 'src/ops/my_op.cu', content: KERNEL, operators: OPERATORS })
  assert.equal(verdict.status, 'unanchored', 'for a recall-first domain this conflation is the dangerous direction')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /没有提供数值测试清单/u)
})

test('"no registry" refuses too — the form cannot be recomputed', () => {
  const verdict = anchor.verify(CLAIM('uncovered-form'), { path: 'src/ops/my_op.cu', content: KERNEL, tests: [] })
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /没有提供算子注册表/u)
})

test('an unknown findingKind is refused rather than treated as a generic edge', () => {
  const verdict = anchor.verify(CLAIM('numeric-drift'), SUBJECT())
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /未知的 findingKind/u)
})

test('a tolerance that exists but is not asserted does not count as usable', () => {
  const verdict = anchor.verify(CLAIM('missing-tolerance'), SUBJECT({
    tests: [{ operator: 'my_op', backend: 'cuda', dtype: 'bf16', shape: 'contiguous', tolerance: { atol: 1e-5 }, asserted: false }],
  }))
  assert.equal(verdict.status, 'anchored', 'a tolerance object with asserted:false constrains nothing')
  assert.match(verdict.detail, /没有一个带可用容差/u)
})

test('indentation is tolerated; a changed parameter name is not', () => {
  const tolerated = anchor.verify(
    { ...CLAIM('uncovered-form'), excerpt: '+\tvoid   my_op( const Tensor& x , int axis ) {' },
    SUBJECT(),
  )
  assert.equal(tolerated.status, 'anchored')

  const changed = anchor.verify(
    { ...CLAIM('uncovered-form'), excerpt: 'void my_op(const Tensor& input, int axis) {' },
    { path: 'src/ops/my_op.cu', content: 'void my_op(const Tensor& input, int axis) {', operators: OPERATORS, tests: [] },
  )
  assert.equal(changed.status, 'unanchored', 'the registry signature says `x`, so `input` is drift')
  assert.equal(changed.tier, 'locator-mismatch')
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { ...CLAIM('uncovered-form'), locator: { ...CLAIM('uncovered-form').locator, startLine: 99 } },
    SUBJECT(),
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'src/ops/my_op.cu', locator: {}, excerpt: 'void my_op(const Tensor& x, int axis) {' },
    { path: 'src/ops/my_op.cu', content: KERNEL },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('an empty excerpt is refused: there is nothing to verify, so nothing is verified', () => {
  const verdict = anchor.verify(
    { ...CLAIM('uncovered-form'), excerpt: '   \n\n  ' },
    { path: 'src/ops/my_op.cu', content: KERNEL },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'empty-excerpt')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'signature-and-tolerance' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'signature-and-tolerance', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['src/ops/my_op.cu'],
  bundle: { key: 'src/ops/my_op.cu', paths: ['src/ops/my_op.cu'], rules: ['dtype-branch-missing'] },
  ruleText: '<rules path="src/ops/my_op.cu">\n某个 dtype 分支未实现：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    {
      id: 'f1',
      path: 'src/ops/my_op.cu',
      evidence: 'void my_op(const Tensor& x, int axis) {',
      message: 'bf16/contiguous 形态没有任何数值测试',
      defended: true,
    },
  ],
}

const P4 = prompts.review(reviewContext)
const P6 = prompts.verify(verifyContext)

test('both prompt roles return objects of strings the contract accepts', () => {
  assert.deepEqual(validatePromptOutput('review', P4), [])
  assert.deepEqual(validatePromptOutput('verify', P6), [])
})

test('P6 is NOT the P4 prompt — this is the assertion the validators do not make', () => {
  assert.notEqual(P6.system, P4.system, 'a P6 prompt identical to P4 deletes the independent re-check layer')
  assert.notEqual(`${P6.system}${P6.instructions}`, P4.system)
})

test('P6 cannot see the P4 reasoning: it is handed findings, not the review transcript', () => {
  assert.ok(!Object.hasOwn(verifyContext, 'ruleText'), 'P6 must not receive rule text')
  assert.doesNotMatch(P6.system, /本轮负责的路径/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /dtype 分支未实现/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /dtype 分支未实现/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts repeat the anchor law: quote the text, never the line number', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /行号/u)
  }
  assert.match(P4.system, /不要输出行号|永远不要输出行号/u)
})

test('recall-first is stated in both prompts, so the domain cannot be silently flipped', () => {
  assert.match(P4.system, /recall-first/u)
  assert.match(P6.system, /recall-first/u)
  const flipped = prompts.review({ ...reviewContext, orientation: 'precision-first' })
  assert.notEqual(flipped.system, P4.system)
  assert.match(flipped.system, /precision-first/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const OPS = [
  { name: 'my_op', signature: 'void my_op(const Tensor& x, int axis)', backends: ['cuda'], dtypes: ['fp32', 'bf16'], shapeBranches: ['contiguous'], path: 'src/ops/my_op.cu', source: '// a\nvoid my_op(const Tensor& x, int axis) {\n  // body\n}' },
]
const TESTS = [
  { operator: 'my_op', backend: 'cuda', dtype: 'fp32', shape: 'contiguous', tolerance: { atol: 1e-5 }, asserted: true },
  { operator: 'my_op', backend: 'cuda', dtype: 'bf16', shape: 'contiguous', tolerance: null, asserted: true },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('read_kernel returns at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('read_kernel')
  const big = [{ name: 'big', signature: 'void big()', backends: ['cuda'], dtypes: ['fp32'], shapeBranches: ['any'], path: 'src/big.cu', source: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }]
  const result = await tool.execute({ path: 'src/big.cu', operators: big }, {})
  assert.ok(result.items.length <= tool.limits.maxLines, `${result.items.length} > ${tool.limits.maxLines}`)
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.equal(typeof result.provenance, 'string')
  assert.ok(result.provenance.length > 0)
})

await testAsync('read_kernel returns the requested window and does not truncate when it fits', async () => {
  const tool = toolByName('read_kernel')
  const result = await tool.execute({ path: 'src/ops/my_op.cu', start: 2, end: 3, operators: OPS }, {})
  assert.deepEqual(result.items.map((item) => item.line), [2, 3])
  assert.equal(result.items[0].text, 'void my_op(const Tensor& x, int axis) {')
  assert.equal(result.truncated, false)
})

await testAsync('coverage_matrix separates uncovered from missing-tolerance', async () => {
  const tool = toolByName('coverage_matrix')
  const result = await tool.execute({ operators: OPS, tests: TESTS }, {})
  assert.deepEqual(result.items.map((item) => `${item.dtype}:${item.status}`), ['fp32:covered', 'bf16:missing-tolerance'])
  assert.equal(result.truncated, false)
})

await testAsync('coverage_matrix caps its form count and reports the cap', async () => {
  const tool = toolByName('coverage_matrix')
  const many = [{
    name: 'many',
    signature: 'void many()',
    backends: Array.from({ length: 10 }, (_, index) => `b${index}`),
    dtypes: Array.from({ length: 10 }, (_, index) => `d${index}`),
    shapeBranches: ['any'],
    path: 'src/many.cu',
  }]
  const result = await tool.execute({ operators: many, tests: [] }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('tolerance_lookup reports asserted and usable separately', async () => {
  const tool = toolByName('tolerance_lookup')
  const result = await tool.execute({ operator: 'my_op', tests: TESTS }, {})
  assert.deepEqual(result.items.map((item) => `${item.dtype}:${item.asserted}:${item.usable}`), ['fp32:true:true', 'bf16:true:false'])
  assert.match(result.provenance, /2 个测试条目/u)
})

await testAsync('a request naming an absent kernel fails loudly with the available paths', async () => {
  const tool = toolByName('read_kernel')
  // The tool throws synchronously: the contract's failure mode is a throw, and
  // `assert.throws` is the assertion that proves it. `assert.rejects` would
  // pass for a tool that merely returned a rejected promise.
  assert.throws(() => tool.execute({ path: 'src/ops/nope.cu', operators: OPS }, {}), /算子实现集里没有/u)
})

await testAsync('a request with no context at all is refused, not answered with "nothing found"', async () => {
  assert.throws(() => toolByName('read_kernel').execute({ path: 'src/ops/my_op.cu' }, {}), /缺少 `operators`/u)
  assert.throws(() => toolByName('coverage_matrix').execute({ operators: OPS }, {}), /缺少 `tests`/u)
  assert.throws(() => toolByName('tolerance_lookup').execute({}, {}), /缺少 `tests`/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('operator-design', 'coverage_matrix'), 'adjudicate_operator_design_evidence_coverage_matrix')
})

// ---------------------------------------------------------------------------
// P4 — the review prompt through the reasoner (no service => honest none)
// ---------------------------------------------------------------------------

console.log('\nP4 — the review prompt is wired to the reasoner')

await testAsync('the reasoner runs the domain prompt over the plan bundles', async () => {
  const { createReasoner } = await import('../../lib/reasoner.js')
  const requests = []
  const reasoner = createReasoner({
    subagents: {
      async start(request) {
        requests.push(request)
        return {
          id: 'child',
          result: Promise.resolve({
            stopReason: 'completed',
            structured: {
              findings: [{
                id: 'f1',
                path: 'src/ops/my_op.cu',
                evidence: 'void my_op(const Tensor& x, int axis) {',
                message: 'bf16/contiguous 形态没有任何数值测试',
                severity: 'high',
                defended: true,
              }],
            },
          }),
          dispose: async () => {},
        }
      },
    },
  }, { maxRounds: 8, maxFindings: 10 })

  const { result } = runP0P1('happy-path')
  const bundles = fixture('happy-path').expect.bundleKeys.map((key) => ({
    key,
    entries: result.selected.filter((entry) => pack.bundleKey.resolve(entry) === key),
  }))
  const budget = createBudget({ maxToolCalls: 50 })
  const outcome = await reasoner.run({
    pack: { ...pack, reviewPrompts: prompts },
    target: 'fixture happy-path',
    bundles,
    budget,
    getBudget: () => budget,
    onCharge: () => {},
  })

  assert.equal(outcome.mode, 'subagents')
  assert.equal(outcome.rounds, bundles.length, 'one bounded pass per bundle')
  assert.ok(requests.length >= 1, 'the reasoner must actually call the child')
  assert.match(requests[0].prompt[0].text, /算子设计/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /不要输出行号/u, 'the anchor law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6 / P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(5, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 5)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, 0.4)
  assert.equal(proof.complete, false)
  assert.equal(coverage(5, [{ path: 'a' }], { requireComplete: true }).required, true,
    'recall-first demands a complete proof')
})

test('recall-first keeps what it cannot disprove and drops only the contradicted', () => {
  const panel = runCritiquePanel([
    { id: 'undecided', path: 'src/ops/my_op.cu', start: 1, severity: 'high', evidence: '', defended: false },
    { id: 'disproved', path: 'src/ops/my_op.cu', start: 2, severity: 'high', evidence: 'x', defended: true, disproved: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['undecided'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['disproved'])
  assert.equal(panel.kind, 'triage')
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  // The anchors are REAL: they come from `anchor.verify` over the fixture's own
  // text, not from a hand-written `anchored: true`.
  const happy = fixture('happy-path')
  const map = new Map(happy.input.payload.operators.map((operator) => [operator.path, operator.source]))
  const good = anchor.verify(
    {
      kind: 'signature-and-tolerance',
      path: 'src/ops/my_op.cu',
      locator: { kind: 'operator-form', path: 'src/ops/my_op.cu', operator: 'my_op', backend: 'cuda', dtype: 'bf16', shapeBranch: 'contiguous', findingKind: 'uncovered-form' },
      excerpt: 'void my_op(const Tensor& x, int axis) {',
    },
    { path: 'src/ops/my_op.cu', content: map.get('src/ops/my_op.cu'), operators: happy.input.payload.operators, tests: happy.input.payload.tests },
  )
  const bad = anchor.verify(
    {
      kind: 'signature-and-tolerance',
      path: 'src/ops/my_op.cu',
      locator: { kind: 'operator-form', path: 'src/ops/my_op.cu', operator: 'my_op', backend: 'cuda', dtype: 'bf16', shapeBranch: 'contiguous', findingKind: 'uncovered-form' },
      excerpt: 'void my_op_renamed(const Tensor& x, int axis) {',
    },
    { path: 'src/ops/my_op.cu', content: map.get('src/ops/my_op.cu'), operators: happy.input.payload.operators, tests: happy.input.payload.tests },
  )
  assert.equal(good.status, 'anchored')
  assert.equal(bad.status, 'unanchored')

  const anchored = [good, bad].filter((verdict) => verdict.status === 'anchored')
  assert.equal(anchored.length, 1)
  const proof = coverage(2, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.5, 'the unanchored path must not be counted as reviewed')
  assert.equal(proof.complete, false)

  const shortfall = coverage(happy.expect.admitted, anchored, { requireComplete: true })
  assert.equal(shortfall.complete, false, 'recall-first must report an incomplete proof as NOT complete')
  assert.equal(shortfall.required, true)
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 'src/ops/my_op.cu', start: 1, severity: 'high', evidence: 'x', defended: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 5, excluded: 0, bundles: 2 },
    findings: panel.kept,
    coverageProof: coverage(5, panel.kept),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'operator-design')
  assert.equal(built.lossOrientation, 'recall-first')
  assert.equal(built.criticismKind, 'triage')
  assert.equal(built.coverage.total, 5)
  assert.equal(built.coverage.reviewed, 1)
  assert.equal(built.coverage.coverageRate, 0.2)
  assert.equal(built.generatedAt, null, 'a deterministic engine must not stamp wall-clock time')
})

// ---------------------------------------------------------------------------
// The domain as loaded from disk
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

/**
 * Every domain directory that actually exists on disk, derived from the LIVE
 * directory listing using the loader's own discovery rule (directory +
 * kebab-case id + a sibling index.js).
 *
 * WHY THIS IS DERIVED AND NOT HARD-CODED: a hard-coded list would assert "how
 * many domains exist TODAY", not "what the rule is" — and would go red the
 * moment a sibling created their directory, for a reason unrelated to this
 * domain. The loader's rule is domain-count independent: every qualifying
 * directory is discovered, none is silently skipped, each pack is counted once.
 */
const DOMAIN_DIRECTORY_IDS = readdirSync(join(here, '..'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/u.test(entry.name))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(here, '..', name, 'index.js')))
  .sort()

/**
 * The accounting invariant that replaces "this domain is the only one in the
 * package". A sibling that is mid-flight (a directory exists but its pack does
 * not yet pass `validateDomainPackV2`) is *correctly* skipped with a readable
 * reason — that is the loader working, not a domain going missing.
 */
function assertEveryDirectoryAccountedFor(result, extraIds = []) {
  const loaded = result.packs.map((item) => item.id)
  const skipped = result.skipped.map((entry) => entry.id)
  const accounted = new Set([...loaded, ...skipped])
  for (const id of [...DOMAIN_DIRECTORY_IDS, ...extraIds]) {
    assert.equal(accounted.has(id), true, `domain directory "${id}" vanished: it is neither loaded nor skipped`)
  }
  assert.equal(accounted.size, loaded.length + skipped.length, 'no directory may be counted twice')
  for (const entry of result.skipped) {
    assert.equal(typeof entry.id === 'string' && entry.id !== '', true, 'every skip names an id')
    const reason = typeof entry.reason === 'string' ? entry.reason : entry.problems?.join('; ')
    assert.equal(typeof reason === 'string' && reason !== '', true, `skipped directory "${entry.id}" must carry a reason`)
  }
}

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: 'operator-design', dir: 'domains/operator-design' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'operator-implementations')
  assert.equal(assembled.anchorVerifier.kind, 'signature-and-tolerance')
  assert.equal(assembled.evidenceTools.tools.length, evidence.tools.length)
  assert.equal(typeof assembled.reviewPrompts.review, 'function')
  assert.equal(typeof assembled.reviewPrompts.verify, 'function')
  assert.ok(assembled.ruleLibrary.rules.length >= MIN_RULES_PER_DOMAIN)
  assert.deepEqual([...assembled.fixtures].sort(), FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')).sort())
  for (const field of ['index.js', 'source.js', 'anchor.js', 'evidence.js', 'prompts.js']) {
    assert.ok(loaded.files.includes(field), `loader must report it loaded ${field}`)
  }
})

await testAsync('the domain id matches its directory name, so no ghost tool names are produced', async () => {
  const io = await packageIo()
  const discovery = discoverDomains(io, { root: 'domains' })
  assert.ok(discovery.found.some((entry) => entry.id === 'operator-design'), 'this domain must be discovered')
  const foundIds = new Set(discovery.found.map((entry) => entry.id))
  for (const entry of discovery.skipped) {
    const reason = typeof entry.reason === 'string' ? entry.reason : entry.problems?.join('; ')
    assert.equal(typeof reason === 'string' && reason !== '', true, `scan-level skip "${entry.id}" must carry a reason`)
    assert.equal(foundIds.has(entry.id), false, `"${entry.id}" cannot be both found and skipped`)
  }

  const result = await loadDomains(io, { root: 'domains' })
  assert.deepEqual(result.problems.filter((entry) => entry.id === 'operator-design'), [], JSON.stringify(result.problems))
  assertEveryDirectoryAccountedFor(result)
  assert.equal(result.packs.some((item) => item.id === 'operator-design'), true, 'this domain must load')
})

await testAsync('a deliberately broken sibling is skipped with a reason, never half-registered', async () => {
  const io = await packageIo()
  const withExtra = {
    readDir: (path) => [
      ...io.readDir(path),
      ...(path === 'domains' ? [{ name: 'bad-domain', isDirectory: true }] : []),
    ],
    readFile: io.readFile,
    exists: (path) => path === 'domains/bad-domain/index.js' || io.exists(path),
    toUrl: io.toUrl,
  }
  const result = await loadDomains(withExtra, {
    root: 'domains',
    loadModule: async (url) => (String(url).includes('bad-domain') ? { default: { id: 'bad-domain' } } : import(url)),
  })
  assertEveryDirectoryAccountedFor(result, ['bad-domain'])
  assert.equal(result.packs.some((item) => item.id === 'bad-domain'), false, 'the broken sibling must not load')
  const broken = result.skipped.filter((entry) => entry.id === 'bad-domain')
  assert.equal(broken.length, 1, 'the broken sibling must be skipped exactly once')
  assert.match(broken[0].reason, /invalid v2 pack/u)
})

// ---------------------------------------------------------------------------
// Through the plugin's own tool surface
// ---------------------------------------------------------------------------

console.log('\nthrough the plugin — P0 -> P7 over a fixture')

function createMockContext() {
  const tools = new Map()
  const effects = []
  const services = new Map()
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    effect(callback, label) {
      const entry = { label, dispose: undefined, undone: false }
      const collect = (disposer) => { if (typeof disposer === 'function') entry.dispose = disposer }
      if (typeof callback === 'function' && callback.constructor?.name === 'GeneratorFunction') {
        const iterator = callback()
        const produced = []
        let step = iterator.next()
        while (step.done !== true) {
          if (typeof step.value === 'function') produced.push(step.value)
          step = iterator.next()
        }
        entry.dispose = () => { for (const disposer of produced) disposer() }
      } else {
        collect(callback())
      }
      effects.push(entry)
      return () => { entry.undone = true; entry.dispose?.() }
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    inject(_names, callback) {
      if (typeof callback === 'function') callback(ctx)
      return () => {}
    },
    provide(name, value) { services.set(name, value) },
    set(name, value) { services.set(name, value) },
    get: (name) => services.get(name),
    __tools: tools,
    __effects: effects,
  }
  return ctx
}

function createPluginContext() {
  const ctx = createMockContext()
  applyPlugin(ctx, { promptSection: false })
  return ctx
}

await testAsync('adjudication_plan consumes the fixture through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'operator-design',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'operator-implementations')
  assert.equal(plan.candidateSet.inputFormat, 'operator-registry-and-tests')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the v2 object form must actually take effect')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.derived, happy.expect.admitted)
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), [...happy.expect.bundleKeys].sort())
  const biggest = plan.bundles.find((item) => item.key === 'src/ops/my_op.cu')
  assert.equal(biggest.paths.length, 3, 'grouping must be real, not one candidate per bundle')
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'operator-design',
    target: 'fixture empty',
    input: { format: empty.input.format, payload: empty.input.payload },
  }, {})
  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /不要凭空审核/u)
})

await testAsync('adjudication_submit refuses a finding it cannot recompute — over-refusing, never over-accepting', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'operator-design',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  const kernel = happy.input.payload.operators.find((operator) => operator.name === 'my_op')
  const documents = [{ path: kernel.path, content: kernel.source }]

  // CHANGED (t20): this block used to record an ENGINE defect. `recomputeAnchor`
  // in `index.js` used to rebuild the claim from the engine's generic anchor
  // vocabulary (`{start, startLine, end, endLine}`), dropping `finding.locator`
  // — so a form-shaped locator (operator / backend / dtype / shapeBranch) never
  // reached this domain's own verifier.
  //
  // That engine behaviour is GONE: `index.js:734` ("CHANGED (t17, second pass)")
  // passes the caller's `locator` through VERBATIM and folds the top-level
  // `start`/`end` in ONLY when no locator was supplied. The finding below is
  // therefore unanchored for a DIFFERENT reason than the old comment gave: it
  // supplies no locator at all, so there is no form to recompute.
  //
  // (That the locator now ARRIVES is asserted one test down, by the contrast
  // between a claim with and without `operator`. What still cannot anchor through
  // `adjudication_submit` is a claim that DOES carry the locator — see the GAP
  // note on that test.)
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'operator-design',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    documents,
    findings: [
      {
        id: 'f1',
        path: 'src/ops/my_op.cu',
        excerpt: 'void my_op(const Tensor& x, int axis) {',
        anchored: true,
        start: 2,
        severity: 'high',
        message: 'bf16/contiguous 形态没有任何数值测试',
        evidence: 'void my_op(const Tensor& x, int axis) {',
        defended: true,
      },
    ],
  }, {})

  assert.equal(submitted.unanchored, 1,
    'a finding the engine could not recompute must NOT be counted as an effective finding, whatever the caller claimed')
  assert.equal(submitted.coverage.reviewed, 0, 'nothing was anchored, so nothing counts as reviewed')
  assert.equal(submitted.coverage.complete, false)
  assert.equal(submitted.coverage.required, true, 'recall-first demands a complete proof')
  assert.equal(submitted.criticismKind, 'triage')
  assert.match(submitted.summary, /覆盖率不完整即为未通过/u)
  assert.match(submitted.summary, /未通过/u)
})

// ---------------------------------------------------------------------------
// The engine boundary: the domain locator must SURVIVE the trip
// ---------------------------------------------------------------------------

console.log('\nthe engine boundary — the domain locator must arrive intact')

await testAsync('the engine hands this domain\'s verifier the caller\'s locator VERBATIM, not a rebuilt one', async () => {
  const ctx = createPluginContext()
  const locator = {
    kind: 'operator-form',
    path: 'src/ops/my_op.cu',
    operator: 'my_op',
    backend: 'cuda',
    dtype: 'bf16',
    shapeBranch: 'contiguous',
    findingKind: 'uncovered-form',
  }

  // `adjudication_anchor` returns the claim the engine actually constructed, so
  // this reads the boundary itself instead of inferring it from a verdict. Under
  // the old engine this would have been `{start, startLine, end, endLine}` (or
  // `{}`), and the deepEqual below would be red.
  const anchored = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'operator-design',
    path: 'src/ops/my_op.cu',
    excerpt: 'void my_op(const Tensor& x, int axis) {',
    locator,
    documents: [{ path: 'src/ops/my_op.cu', content: '// my_op kernel\nvoid my_op(const Tensor& x, int axis) {\n}' }],
  }, {})

  assert.equal(anchored.via, 'anchorVerifier', 'the engine must route through the pack anchorVerifier')
  assert.deepEqual(anchored.claim.locator, locator,
    'the locator must arrive byte-for-byte; a rebuilt {start,startLine,end,endLine} would prove the old defect is back')
  assert.equal(anchored.claim.kind, 'signature-and-tolerance')
})

await testAsync('a finding carrying this domain\'s locator is anchored THROUGH adjudication_submit and counted in coverage', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'operator-design',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})
  const kernel = happy.input.payload.operators.find((operator) => operator.name === 'my_op')

  // FLIPPED (t23). This used to be a GAP probe: carrying the locator reached the
  // verifier and was then REFUSED, because `formCheck` demanded
  // `subject.operators` / `subject.tests` while the engine hands over only
  // `{ path, content, document, documents }`. It was written to go red the day the
  // gap closed, and it did.
  //
  // What closed it: the form space is rebuilt from the engine's own candidate set
  // (`subject.candidates`). The documents below carry the implementation text and
  // NOTHING else — no `operators`, no `tests` — so an anchor here can only have
  // come from the candidates.
  const documents = [{ path: kernel.path, content: kernel.source }]
  const submit = (finding) => ctx.__tools.get('adjudication_submit').execute({
    domain: 'operator-design',
    target: 'fixture happy-path',
    documents,
    findings: [{
      id: 'f1',
      path: kernel.path,
      excerpt: 'void my_op(const Tensor& x, int axis) {',
      evidence: 'void my_op(const Tensor& x, int axis) {',
      severity: 'high',
      message: 'bf16/contiguous 形态没有任何数值测试',
      defended: true,
      ...finding,
    }],
  }, {})
  const form = {
    kind: 'operator-form',
    path: kernel.path,
    operator: 'my_op',
    backend: 'cuda',
    dtype: 'bf16',
    shapeBranch: 'contiguous',
    findingKind: 'uncovered-form',
  }

  const anchored = await submit({ locator: form })
  assert.equal(anchored.anchorVia, 'anchorVerifier')
  assert.equal(anchored.unanchored, 0, 'a finding whose locator the verifier can recompute must anchor')
  assert.equal(anchored.findings.length, 1)
  const finding = anchored.findings[0]
  assert.equal(finding.anchored, true)
  assert.equal(finding.anchorTier, 'recomputed-unique')
  assert.ok(TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier))
  assert.equal(finding.anchorLocator.operator, 'my_op')
  assert.equal(finding.anchorLocator.backend, 'cuda')
  assert.equal(finding.anchorLocator.shapeBranch, 'contiguous')
  assert.equal(anchored.coverage.reviewed, 1, 'the anchored path must be counted as reviewed')
  assert.equal(anchored.coverage.total, new Set(happy.expect.paths).size, 't51: the denominator is the plan admission measured in the unit coverage() reports (distinct paths, not candidates)')
  assert.equal(anchored.coverage.totalSource, 'plan')
  assert.equal(anchored.criticismKind, 'triage')

  // The locator is what carries the form. Without it the verifier never learns
  // which operator is meant, and says exactly that.
  const withoutLocator = await submit({})
  assert.equal(withoutLocator.unanchored, 1)
  assert.equal(withoutLocator.unanchoredDetails[0].detail.includes('没有点名算子'), true)

  // REFUSAL IS UNCHANGED — the other half of the flip, and the reason the
  // assertion above is worth anything. Closing the gap must not convert "cannot
  // verify" into "let it through":
  //   (a) a form the plan never enumerated;
  const invented = await submit({ locator: { ...form, shapeBranch: 'tiled' } })
  assert.equal(invented.unanchored, 1)
  assert.equal(invented.findings.length, 0)
  assert.match(invented.unanchoredDetails[0].detail, /没有 cuda\/bf16\/tiled 这个形态/u)
  //   (b) a form the plan enumerated, but classified the OTHER way round.
  const relabelled = await submit({ locator: { ...form, dtype: 'fp32', shapeBranch: 'strided' } })
  assert.equal(relabelled.unanchored, 1)
  assert.equal(relabelled.findings.length, 0)
  assert.match(relabelled.unanchoredDetails[0].detail, /两者矛盾/u)
  //   (c) and the basis is named, so a plan-derived match is not mistaken for a
  //       re-reading of the numeric test manifest (which the engine never forwards).
  assert.match(invented.unanchoredDetails[0].detail, /候选集/u)
})

await testAsync('the domain-local half anchors correctly when the locator it declares is supplied', async () => {
  const happy = fixture('happy-path')
  const sourceOf = new Map(happy.input.payload.operators.map((operator) => [operator.path, operator.source]))
  const form = (overrides) => ({
    kind: 'signature-and-tolerance',
    path: 'src/ops/my_op.cu',
    locator: {
      kind: 'operator-form',
      path: 'src/ops/my_op.cu',
      operator: 'my_op',
      backend: 'cuda',
      dtype: 'bf16',
      shapeBranch: 'contiguous',
      findingKind: 'uncovered-form',
      ...overrides,
    },
    excerpt: 'void my_op(const Tensor& x, int axis) {',
  })
  const subject = {
    path: 'src/ops/my_op.cu',
    content: sourceOf.get('src/ops/my_op.cu'),
    operators: happy.input.payload.operators,
    tests: happy.input.payload.tests,
  }

  const anchored = anchor.verify(form(), subject)
  const contradicted = anchor.verify(form({ dtype: 'fp32', shapeBranch: 'contiguous' }), subject)
  assert.equal(anchored.status, 'anchored')
  assert.equal(anchored.tier, 'recomputed-unique')
  assert.equal(contradicted.status, 'unanchored', 'the manifest covers this form, so the gap claim is contradicted')
  assert.equal(contradicted.tier, 'locator-mismatch')

  // The coverage proof that follows from the real verdicts — computed, not typed in.
  const kept = [anchored].filter((verdict) => verdict.status === 'anchored')
  const proof = coverage(happy.expect.admitted, kept, { requireComplete: true })
  assert.equal(proof.total, 5)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.2)
  assert.equal(proof.complete, false)
  assert.equal(proof.required, true)
})

await testAsync('adjudication_activate registers this domain\'s own tool names', async () => {
  const ctx = createPluginContext()
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.ok(listed.domains.some((item) => item.id === 'operator-design'), 'operator-design must be in the registry')
  const directory = listed.directory
  assert.ok(directory !== null, 'the directory report must be present once directory domains exist')
  assert.ok(directory.loaded.includes('operator-design'), `loaded: ${directory.loaded.join(', ')}`)
  assert.deepEqual(directory.problems.filter((entry) => entry.id === 'operator-design'), [])

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'operator-design' }, {})
  assert.equal(activated.ok, true, activated.summary)
  for (const name of ['adjudicate_operator_design', 'adjudicate_operator_design_plan', 'adjudicate_operator_design_rules']) {
    assert.ok(ctx.__tools.has(name), `missing tool ${name}`)
  }
})

// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log('failed:')
  for (const title of failedTitles) console.log(`  - ${title}`)
  process.exitCode = 1
}
