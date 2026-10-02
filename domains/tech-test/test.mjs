/**
 * tech-test — domain end-to-end test (contract v2, `test.mjs`).
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
 * Then it drives the assembled pack through the plugin's own mock Cordis
 * context, so the domain is proven to work where it is actually used and not
 * merely in isolation.
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
 *    `adjudication_submit` trusts a caller-supplied `finding.anchored`, so an
 *    assertion built on self-reported anchors would prove nothing.
 * 4. It never hard-codes "tech-test is the only domain in `domains/`". That is a
 *    statement about the calendar, not about the loader.
 *
 * Usage: `node domains/tech-test/test.mjs`
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

console.log('\ntech-test domain — contract v2 end-to-end')
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
  const declared = inputFormatFor('tech-test')
  assert.equal(declared.format, 'test-inventory-and-coverage')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
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
  // `module` is this domain's private name, so it MUST supply `resolve`.
  assert.equal(typeof pack.bundleKey, 'object')
  assert.equal(pack.bundleKey.strategy, 'module')
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
    { name: 'go-only', match: ['**/*.go'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['src/app.ts'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  // The documented fourth fixture for this format is the whole-file case.
  assert.ok(FIXTURES.has('zero-coverage-file'))
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
  assert.equal(inputFormatFor('tech-test').bounded, true)
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate([], {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ coverage: { files: {} } }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ cases: [], source: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ cases: [], coverage: [] }, {}), /E_INPUT_FORMAT/u)
  // CHANGED (input-format): the maps INSIDE `coverage` and `source` carry the
  // domain's evidence. Reading a malformed one as "empty" does not shrink the
  // review — it makes the domain assert that files are unexecuted on the
  // strength of a field it could not read (one mutation produced 16 exclusions).
  assert.throws(() => source.enumerate({ cases: [], coverage: { files: 'nope' } }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ cases: [], coverage: { files: [] } }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ cases: [], source: { 'a.ts': 'nope' } }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ cases: [], coverage: { files: {} } }, {}))
  assert.doesNotThrow(() => source.enumerate({ cases: [], source: { 'a.ts': { lines: [] } } }, {}))
  // An EMPTY inventory is NOT malformed: "nothing to look at" is a legitimate
  // answer, and it must be distinguishable from "your request made no sense".
  assert.doesNotThrow(() => source.enumerate({ cases: [] }, {}))
  assert.doesNotThrow(() => source.enumerate({ cases: [], coverage: { files: {} }, source: {} }, {}))
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
  // measured through the real plugin, `generated/types.ts` was admitted.
  //
  // So the fixture no longer carries a gate at all, and the gate below is built
  // from the pack ONLY. The first assertion is what keeps it that way.
  assert.equal(value.gate, undefined, 'the fixture must not be doing the work its own boundary claims')

  const { result } = runP1PackOnly('all-gated-out')
  const { enumerated } = runP0P1('all-gated-out')
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
  const generated = result.excluded.find((item) => item.path === 'generated/types.ts')
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
  assert.deepEqual(control.selected.map((item) => item.path), ['generated/types.ts'],
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

test('a file with no coverage entry at all becomes one whole-file gap', () => {
  const { enumerated, result } = runP0P1('zero-coverage-file')
  assert.equal(enumerated.candidates.length, 1)
  assert.equal(enumerated.candidates[0].path, 'src/legacy/report.ts')
  assert.equal(enumerated.candidates[0].locator.startLine, 1)
  assert.equal(enumerated.candidates[0].locator.endLine, 5)
  assert.equal(result.selected.length, 1)
})

test('a line the report never mentions is NOT turned into a gap', () => {
  // The distinction the whole source rests on: "measured zero" vs "unmeasured".
  // `src/core/engine.ts` lists lines 1-4 only; line 5 exists in the file but is
  // not in the report, so it must not appear as a finding.
  const enumerated = source.enumerate({
    cases: [],
    coverage: { files: { 'src/a.ts': { lines: { '1': 1, '2': 1 } } } },
    source: { 'src/a.ts': { lines: ['a', 'b', 'c', 'd'] } },
  }, {})
  assert.deepEqual(enumerated.candidates, [])
  assert.ok(enumerated.notes.some((note) => /没有任何行记录|没有任何覆盖数据/u.test(note)) === false)
})

test('contiguous never-executed lines merge into one span, and the span is reported', () => {
  const enumerated = source.enumerate({
    cases: [],
    coverage: { files: { 'src/a.ts': { lines: { '1': 1, '2': 0, '3': 0, '4': 0, '5': 1, '8': 0 } } } },
    source: { 'src/a.ts': { lines: ['1', '2', '3', '4', '5', '6', '7', '8'] } },
  }, {})
  assert.deepEqual(enumerated.candidates.map((item) => `${item.locator.startLine}-${item.locator.endLine}`), ['2-4', '8-8'])
})

test('an uncovered branch becomes its own candidate, with the line parsed from the key', () => {
  const value = fixture('happy-path')
  const enumerated = source.enumerate(value.input.payload, {})
  const branches = enumerated.candidates.filter((item) => item.locator.kind === 'uncovered-branch')
  // `if@4` was taken three times, so it is NOT a gap; `then@5` and `catch@9`
  // never ran. The counts are what decide, not the presence of the key.
  assert.deepEqual(branches.map((item) => item.locator.branch), ['catch@9', 'then@5'])
  assert.deepEqual(branches.map((item) => item.locator.branchLine), [9, 5])
  assert.ok(branches.every((item) => item.path === 'src/core/engine.ts'), 'the path stays the real file, never the branch key')
})

test('a never-taken branch with an unparseable key is still reported, with branchLine null', () => {
  const enumerated = source.enumerate({
    cases: [],
    coverage: { files: { 'src/a.ts': { lines: { '1': 1 }, branches: { 'weird-key': 0 } } } },
    source: { 'src/a.ts': { lines: ['a'] } },
  }, {})
  const branch = enumerated.candidates.find((item) => item.locator.kind === 'uncovered-branch')
  assert.ok(branch !== undefined, 'dropping it would silently lose exactly what the report exists for')
  assert.equal(branch.locator.branchLine, null)
})

test('candidate ids are unique and `path` stays a gate-globable file path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'a synthetic id must never leak into candidate.path')
    assert.doesNotMatch(candidate.path, /@/u, 'a branch key must never leak into candidate.path')
  }
})

test('the source reports excluded items and notes rather than dropping them', () => {
  const enumerated = source.enumerate({
    cases: [{ id: 't1', file: 'src/missing.spec.ts', assertions: [] }],
    coverage: { files: { 'src/ghost.ts': { lines: { '1': 0 } } } },
    source: { 'src/a.ts': { lines: ['a'] } },
  }, {})
  assert.ok(enumerated.excluded.some((item) => item.id === 'src/ghost.ts'), 'a coverage entry with no snapshot must be reported')
  assert.ok(enumerated.excluded.some((item) => item.id === 't1'), 'an unquotable weak-assertion case must be reported')
})

test('a weak-assertion case becomes a candidate on the TEST file path', () => {
  const value = fixture('happy-path')
  const enumerated = source.enumerate(value.input.payload, {})
  const weak = enumerated.candidates.filter((item) => item.locator.kind === 'weak-assertion')
  assert.deepEqual(weak.map((item) => item.id), ['case-t2', 'case-t3'])
  assert.ok(weak.every((item) => item.path === 'src/api/handler.spec.ts'))
  assert.equal(weak[0].meta.weakReason, 'all-assertions-weak')
  assert.equal(weak[1].meta.weakReason, 'no-assertions')
  // A case with a real assertion is not reported. This is the negative control
  // for the whole class.
  assert.equal(enumerated.candidates.some((item) => item.id === 'case-t1'), false)
})

test('a candidate larger than the ceiling is removed by the too-large predicate', () => {
  const result = gate([{ path: 'src/huge.ts', bytes: 4096 }], { extensions: pack.gate.extensions, maxFileBytes: 1024 })
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

test('the pack excludes generated test scaffolding and nothing of its own invention beyond that', () => {
  // The one rule this domain genuinely adds. Asserted as a PROPERTY of the rule —
  // it names generated paths and it is load-bearing — rather than as "the list has
  // exactly N entries", which is the shape that broke when the rule was moved here
  // from the fixture.
  const invented = pack.gate.exclude.filter((pattern) => !DEFAULT_EXCLUDE_PATTERNS.includes(pattern))
  assert.ok(invented.some((pattern) => pattern.includes('generated')),
    'generated test scaffolding must be excluded by the pack itself, not by a fixture')
  // The pack must NOT exclude test paths: this domain's weak-assertion
  // candidates live in test files, and excluding them would delete half the
  // candidate set before any reviewer saw it.
  assert.equal(pack.gate.exclude.some((pattern) => /\*\.test\.|\*\.spec\.|tests?\//u.test(pattern)), false)
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling')

test('the module resolver groups by the path\'s module root, not by path', () => {
  assert.equal(pack.bundleKey.resolve({ path: 'src/core/engine.ts' }), 'src/core')
  assert.equal(pack.bundleKey.resolve({ path: 'pkg/util/bytes.ts' }), 'pkg/util')
  assert.equal(pack.bundleKey.resolve({ path: 'top.ts' }), '.')
  // The resolver must not read anything the engine refuses to forward: index.js
  // `toCandidates()` copies a fixed field set, so a resolver that wanted `meta`
  // would silently see `undefined`.
  assert.equal(pack.bundleKey.resolve({ path: 'src/core/engine.ts', meta: { module: 'WRONG' } }), 'src/core')
})

test('two candidates from the same module really land in the same bundle', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: pack.bundleKey.resolve(entry) }))
  const byKey = new Map()
  for (const entry of keyed) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, [])
    byKey.get(entry.key).push(entry)
  }
  assert.deepEqual([...byKey.keys()].sort(), [...fixture('happy-path').expect.bundleKeys].sort())
  assert.equal(byKey.get('src/core').length, 4, 'src/core contributes four gaps and they must share a bundle')
  assert.equal(byKey.get('src/api').length, 3, 'the two weak-assertion cases and one line gap share src/api')
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

const ENGINE = 'export function run(input: string): string {\n  if (!input) {\n    return \'\'\n  }\n  return input.trim()\n}\n'

test('a paraphrase never anchors, even when the intent is obvious', () => {
  const verdict = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: {}, excerpt: 'return input.toLowerCase()' },
    { path: 'src/a.ts', content: ENGINE, coverage: { files: { 'src/a.ts': { lines: { '1': 1 } } } } },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a changed punctuation mark is a changed line', () => {
  const verdict = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: {}, excerpt: 'return input.trim();' },
    { path: 'src/a.ts', content: ENGINE, coverage: { files: { 'src/a.ts': { lines: { '1': 1 } } } } },
  )
  assert.equal(verdict.status, 'unanchored', 'indentation tolerance must not extend to punctuation')
  assert.equal(verdict.tier, 'no-match')
})

test('indentation and diff markers ARE tolerated — the model is not asked to be a formatter', () => {
  const verdict = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: {}, excerpt: '+\treturn   input.trim()' },
    { path: 'src/a.ts', content: ENGINE, coverage: { files: { 'src/a.ts': { lines: { '1': 1, '5': 0 } } } } },
  )
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'recomputed-unique')
  assert.equal(verdict.start, 5)
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: { startLine: 99 }, excerpt: 'return input.trim()' },
    { path: 'src/a.ts', content: ENGINE, coverage: { files: { 'src/a.ts': { lines: { '1': 1 } } } } },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('the coverage report can POSITIVELY DISPROVE a gap claim — that is what makes this an anchor', () => {
  const verdict = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: {}, excerpt: 'return input.trim()' },
    { path: 'src/a.ts', content: ENGINE, coverage: { files: { 'src/a.ts': { lines: { '1': 1, '5': 3 } } } } },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /已被覆盖/u)
})

test('an absent coverage entry REFUSES the claim — "unknown" is not "verified"', () => {
  // CHANGED (t23). This used to assert `anchored` with "position is real; only
  // the coverage claim is unverified". That made the domain's own contract
  // self-contradictory: the header (anchor.js:6-16) says a claim survives only if
  // BOTH checks hold, and check 2 is what separates an anchor from a text search.
  // The measurement that settled it: the same assertion came back UNANCHORED when
  // the line was hit 7 times with the report supplied, and ANCHORED when the
  // report was simply withheld — i.e. dropping evidence bought a pass.
  const verdict = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: {}, excerpt: 'return input.trim()' },
    { path: 'src/a.ts', content: ENGINE, coverage: { files: {} } },
  )
  assert.notEqual(verdict.status, 'anchored', 'a missing coverage table must never produce an anchored verdict')
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /无法核验/u)
  assert.match(verdict.detail, /不予锚定/u)
  // And the refusal must mention WHICH path's table is missing, or the reviewer
  // cannot tell what to go and fetch.
  assert.match(verdict.detail, /src\/a\.ts/u)

  // The same claim WITH a table that has no hits for the span is the opposite
  // case, and it anchors — so the change refuses "no data", not "no coverage".
  const withTable = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: {}, excerpt: 'return input.trim()' },
    { path: 'src/a.ts', content: ENGINE, coverage: { files: { 'src/a.ts': { lines: { '1': 1 } } } } },
  )
  assert.equal(withTable.status, 'anchored')
  assert.equal(withTable.tier, 'recomputed-unique')
  assert.match(withTable.detail, /缺口主张成立/u)
})

test('a cross-file relocation must be unique', () => {
  const documents = [
    { path: 'src/one.ts', content: 'const shared = 1\n' },
    { path: 'src/two.ts', content: 'const shared = 1\n' },
  ]
  const ambiguous = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/missing.ts', locator: {}, excerpt: 'const shared = 1' },
    { path: 'src/missing.ts', documents },
  )
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['src/one.ts:1', 'src/two.ts:1'])

  const unique = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/missing.ts', locator: {}, excerpt: 'const shared = 1' },
    // CHANGED (t23): the relocated file needs a coverage entry now that check 2 is
    // fail-closed — the span is recomputed against `src/one.ts`, so that is the
    // path whose table must exist.
    { path: 'src/missing.ts', documents: [documents[0]], coverage: { files: { 'src/one.ts': { lines: { '1': 0 } } } } },
  )
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
  assert.equal(unique.path, 'src/one.ts')

  // ...and the relocated file WITHOUT a table is refused, for the same reason.
  const uniqueNoTable = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/missing.ts', locator: {}, excerpt: 'const shared = 1' },
    { path: 'src/missing.ts', documents: [documents[0]] },
  )
  assert.equal(uniqueNoTable.status, 'unanchored')
  assert.equal(uniqueNoTable.tier, 'locator-mismatch')
  assert.match(uniqueNoTable.detail, /src\/one\.ts/u)
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'src/a.ts', locator: {}, excerpt: 'x' },
    { path: 'src/a.ts', content: 'x\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('an empty excerpt is refused: there is nothing to verify, so nothing is verified', () => {
  const verdict = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/a.ts', locator: {}, excerpt: '   \n\n  ' },
    { path: 'src/a.ts', content: 'x\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'empty-excerpt')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'case-and-covered-line' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'case-and-covered-line', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['src/core/engine.ts'],
  bundle: { key: 'src/core', paths: ['src/core/engine.ts'], rules: ['uncovered-branch'] },
  ruleText: '<rules path="src/core/engine.ts">\n未被任何用例覆盖的分支：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', path: 'src/core/engine.ts', evidence: "return 'halted'", message: 'STOP 分支从未被执行', defended: true },
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
  assert.match(P4.system, /未被任何用例覆盖的分支/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /未被任何用例覆盖的分支/u)
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

const SOURCE_MAP = {
  'src/a.ts': { lines: ['line1', 'line2', 'needle here', 'line4'] },
  'src/b.ts': { lines: ['needle also here'] },
}
const COVERAGE_MAP = {
  files: {
    'src/a.ts': { lines: { '1': 1, '2': 0, '3': 2 }, branches: { 'if@2': 0 } },
    'src/b.ts': { lines: { '1': 1 }, branches: {}, cases: ['t9'] },
  },
}
const CASES = [
  { id: 't9', file: 'src/b.ts', assertions: [{ kind: 'no-throw', target: 'b' }] },
  { id: 't1', name: 'alpha case', file: 'src/a.ts', assertions: [{ kind: 'equals', target: 'x' }] },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('source_lines returns at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('source_lines')
  const big = { 'src/big.ts': { lines: Array.from({ length: 900 }, (_, index) => `l${index + 1}`) } }
  const result = await tool.execute({ path: 'src/big.ts', start: 1, source: big, coverage: { files: {} } }, {})
  assert.ok(result.items.length <= tool.limits.maxLines, `${result.items.length} > ${tool.limits.maxLines}`)
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.equal(typeof result.provenance, 'string')
  assert.ok(result.provenance.length > 0)
})

await testAsync('source_lines marks each line as covered or not, from the P0-shaped coverage map', async () => {
  const tool = toolByName('source_lines')
  const result = await tool.execute({ path: 'src/a.ts', start: 1, end: 4, source: SOURCE_MAP, coverage: COVERAGE_MAP }, {})
  assert.deepEqual(result.items.map((item) => item.line), [1, 2, 3, 4])
  assert.deepEqual(result.items.map((item) => item.covered), [true, false, true, false])
  assert.equal(result.truncated, false)
})

await testAsync('coverage_query caps its hit count and refuses an unbounded dump', async () => {
  const tool = toolByName('coverage_query')
  const many = { files: {} }
  for (let index = 0; index < 200; index += 1) many.files[`src/f${index}.ts`] = { lines: { '1': 1 }, cases: ['t9'] }
  const result = await tool.execute({ caseId: 't9', coverage: many }, {})
  assert.ok(result.items.length <= tool.limits.maxItems)
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
  assert.throws(() => tool.execute({ coverage: COVERAGE_MAP }, {}), /至少一个/u)
})

await testAsync('coverage_query reports the provenance of what it scanned', async () => {
  const tool = toolByName('coverage_query')
  const result = await tool.execute({ path: 'src/a.ts', coverage: COVERAGE_MAP }, {})
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].coveredLineCount, 2)
  assert.match(result.provenance, /2 个覆盖条目/u)
  assert.equal(result.truncated, false)
})

await testAsync('case_lookup finds a case by id and answers which files it ran', async () => {
  const tool = toolByName('case_lookup')
  const result = await tool.execute({ id: 't9', cases: CASES, coverage: COVERAGE_MAP }, {})
  assert.equal(result.items.length, 1)
  assert.deepEqual(result.items[0].assertionKinds, ['no-throw'])
  assert.deepEqual(result.items[0].coveredFiles, ['src/b.ts'])
  assert.match(result.provenance, /精确/u)
})

await testAsync('case_lookup falls back to a name substring and says which mode it used', async () => {
  const tool = toolByName('case_lookup')
  const result = await tool.execute({ id: 'alpha', cases: CASES, coverage: COVERAGE_MAP }, {})
  assert.deepEqual(result.items.map((item) => item.id), ['t1'])
  assert.match(result.provenance, /名称子串/u)
})

await testAsync('a request naming an absent document fails loudly with the available paths', async () => {
  const tool = toolByName('source_lines')
  // The tool throws synchronously: the contract's failure mode is a throw, and
  // `assert.throws` is the assertion that proves it. `assert.rejects` would
  // pass for a tool that merely returned a rejected promise.
  assert.throws(() => tool.execute({ path: 'src/nope.ts', source: SOURCE_MAP, coverage: COVERAGE_MAP }, {}),
    /源码集里没有 "src\/nope\.ts"/u)
})

await testAsync('a request with no context at all is refused, not answered with "nothing found"', async () => {
  assert.throws(() => toolByName('source_lines').execute({ path: 'src/a.ts' }, {}), /缺少 `source`/u)
  assert.throws(() => toolByName('coverage_query').execute({ path: 'src/a.ts' }, {}), /缺少 `coverage`/u)
  assert.throws(() => toolByName('case_lookup').execute({ id: 't1' }, {}), /缺少 `cases`/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('tech-test', 'source_lines'), 'adjudicate_tech_test_evidence_source_lines')
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
                path: 'src/core/engine.ts',
                evidence: "return 'halted'",
                message: 'STOP 分支从未被执行',
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
  assert.match(requests[0].prompt[0].text, /技术测试/u, 'the domain prompt must be the one sent')
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
  assert.equal(coverage(2, [{ path: 'a' }, { path: 'b' }], { requireComplete: true }).complete, true)
})

test('recall-first keeps what it cannot disprove and drops only the contradicted', () => {
  const panel = runCritiquePanel([
    { id: 'undecided', path: 'src/a.ts', start: 1, severity: 'high', evidence: '', defended: false },
    { id: 'disproved', path: 'src/a.ts', start: 2, severity: 'high', evidence: 'x', defended: true, disproved: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['undecided'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['disproved'])
  assert.equal(panel.kind, 'triage')
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  // The anchors are REAL: they come from `anchor.verify` over the fixture's own
  // text, not from a hand-written `anchored: true`. A self-reported anchor would
  // make this assertion vacuous.
  const value = fixture('happy-path')
  const documents = Object.entries(value.input.payload.source)
    .map(([path, entry]) => ({ path, content: entry.lines.join('\n') }))
  const coverageMap = value.input.payload.coverage

  const good = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/api/handler.ts', locator: { startLine: 4 }, excerpt: "return reject(400, 'bad request')" },
    { path: 'src/api/handler.ts', content: value.input.payload.source['src/api/handler.ts'].lines.join('\n'), coverage: coverageMap },
  )
  const bad = anchor.verify(
    { kind: 'case-and-covered-line', path: 'src/api/handler.ts', locator: {}, excerpt: "return reject(400, 'wrong text')" },
    { path: 'src/api/handler.ts', content: value.input.payload.source['src/api/handler.ts'].lines.join('\n'), documents, coverage: coverageMap },
  )
  assert.equal(good.status, 'anchored')
  assert.equal(bad.status, 'unanchored')

  const findings = [good, bad]
  const anchored = findings.filter((finding) => finding.status === 'anchored')
  assert.equal(anchored.length, 1)
  const proof = coverage(2, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.5, 'the unanchored path must not be counted as reviewed')
  assert.equal(proof.complete, false)
  assert.equal(fixture('happy-path').expect.admitted, 8)
  const shortfall = coverage(fixture('happy-path').expect.admitted, anchored, { requireComplete: true })
  assert.equal(shortfall.complete, false, 'recall-first must report an incomplete proof as NOT complete')
  assert.equal(shortfall.required, true)
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 'src/a.ts', start: 1, severity: 'high', evidence: 'x', defended: true }],
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
  assert.equal(built.domain, 'tech-test')
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
 * WHY THIS IS DERIVED AND NOT HARD-CODED: `assert.deepEqual(found, ['tech-test'])`
 * would assert "how many domains exist TODAY", not "what the rule is". It was
 * true only on the day it was written, and went red the moment a second domain
 * owner created their directory — for a reason that had nothing to do with
 * their work. The rule the loader promises is domain-count independent: every
 * qualifying directory is discovered, none is silently skipped, each loaded
 * pack is accounted for exactly once.
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
  const loaded = await loadDomain(io, { id: 'tech-test', dir: 'domains/tech-test' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'cases-and-covered-lines')
  assert.equal(assembled.anchorVerifier.kind, anchor.kind)
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
  assert.ok(discovery.found.some((entry) => entry.id === 'tech-test'), 'this domain must be discovered')
  const foundIds = new Set(discovery.found.map((entry) => entry.id))
  for (const entry of discovery.skipped) {
    const reason = typeof entry.reason === 'string' ? entry.reason : entry.problems?.join('; ')
    assert.equal(typeof reason === 'string' && reason !== '', true, `scan-level skip "${entry.id}" must carry a reason`)
    assert.equal(foundIds.has(entry.id), false, `"${entry.id}" cannot be both found and skipped`)
  }

  const result = await loadDomains(io, { root: 'domains' })
  assert.deepEqual(result.problems.filter((entry) => entry.id === 'tech-test'), [], JSON.stringify(result.problems))
  assertEveryDirectoryAccountedFor(result)
  assert.equal(result.packs.some((item) => item.id === 'tech-test'), true, 'this domain must load')
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
    domain: 'tech-test',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'cases-and-covered-lines')
  assert.equal(plan.candidateSet.inputFormat, 'test-inventory-and-coverage')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the v2 object form must actually take effect')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.derived, happy.expect.admitted)
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), [...happy.expect.bundleKeys].sort())
  const biggest = plan.bundles.find((item) => item.key === 'src/core')
  assert.equal(biggest.paths.length, 4, 'grouping must be real, not one candidate per bundle')
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'tech-test',
    target: 'fixture empty',
    input: { format: empty.input.format, payload: empty.input.payload },
  }, {})
  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /不要凭空审核/u)
})

await testAsync('the plan over the all-gated-out fixture reports every gate reason', async () => {
  const ctx = createPluginContext()
  const gated = fixture('all-gated-out')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'tech-test',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})

  // CHANGED (t23): through the plugin the pack's OWN gate applies, and the pack
  // now excludes `**/generated/**` itself — so nothing survives. Before this
  // change the assertion here read `admitted === 1` and the surviving candidate
  // was `generated/types.ts`: the fixture's narrowing had been hiding a real gap
  // between the boundary claim and the production gate.
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'node_modules/leftpad/index.js': 'default-path',
    '.git/hooks/pre-commit.js': 'user-exclude',
    'dist/bundle.js': 'user-exclude',
    'build/cli.js': 'user-exclude',
    'generated/types.ts': 'user-exclude',
  })
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.gate.excluded.every((item) => typeof item.reason === 'string' && item.reason !== ''), true,
    'an exclusion without a reason is the thing this whole report exists to prevent')
})

await testAsync('adjudication_submit over report-real anchors reports an INCOMPLETE recall-first proof as not passed', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const documents = Object.entries(happy.input.payload.source)
    .map(([path, entry]) => ({ path, content: entry.lines.join('\n') }))

  // Real anchors, computed by the domain verifier over real text. Nothing here
  // reads a caller-supplied `anchored` flag.
  const verdicts = [
    anchor.verify(
      { kind: 'case-and-covered-line', path: 'src/api/handler.ts', locator: { startLine: 4 }, excerpt: "return reject(400, 'bad request')" },
      { path: 'src/api/handler.ts', documents, coverage: happy.input.payload.coverage },
    ),
    anchor.verify(
      { kind: 'case-and-covered-line', path: 'src/core/engine.ts', locator: {}, excerpt: 'return input.trim()' },
      { path: 'src/core/engine.ts', documents, coverage: happy.input.payload.coverage },
    ),
  ]
  assert.deepEqual(verdicts.map((verdict) => verdict.status), ['anchored', 'unanchored'],
    'the second excerpt is not in the fixture source, so it must not anchor')

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'tech-test',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  const findings = verdicts.map((verdict, index) => ({
    id: `f${index + 1}`,
    path: verdict.path ?? 'src/api/handler.ts',
    start: verdict.start,
    end: verdict.end,
    anchored: verdict.status === 'anchored',
    severity: 'high',
    message: `缺口 ${index + 1}`,
    evidence: index === 0 ? "return reject(400, 'bad request')" : 'return input.trim()',
  }))

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'tech-test',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    // t17: `adjudication_submit` recomputes every anchor itself and ignores the
    // caller's `anchored`/`start`. Without the documents it has nothing to
    // recompute against, and everything is (correctly) judged unanchored.
    //
    // CHANGED (t23): the documents now carry the coverage report too. Before F2 was
    // fixed, omitting it was free — check 2 silently passed — so the submit path
    // could "anchor" a coverage claim while holding no coverage data at all. The
    // report rides on the forwarded document because that is what the engine
    // forwards whole; see `toCoverage` in anchor.js.
    documents: documents.map((document) => ({ ...document, coverage: happy.input.payload.coverage })),
    findings,
  }, {})

  assert.equal(submitted.unanchored, 1, 'the unanchored finding must be counted separately')
  // t51: the denominator is the plan's admission measured in the unit `coverage()`
  // reports — DISTINCT paths. This coverage-report fixture is the case where the
  // two units happen to COINCIDE (8 candidates, 8 distinct paths), which is why
  // the number is unchanged; in a domain whose candidates share files they differ,
  // and the old candidate-count floor made `complete` unreachable there.
  assert.equal(submitted.coverage.total, 8, 'coverage counts DISTINCT ANCHORED paths')
  assert.equal(submitted.coverage.reviewed, 1, 'coverage counts DISTINCT ANCHORED paths')
  assert.equal(submitted.coverage.complete, false)
  assert.equal(submitted.coverage.required, true)
  assert.equal(submitted.criticismKind, 'triage')
  assert.match(submitted.summary, /覆盖率不完整即为未通过/u)
  assert.match(submitted.summary, /未通过/u)

  // GAP (t23): and WITHOUT the report the same anchored finding is now judged
  // unanchored, which is the F2 behaviour change seen from the plugin side. This
  // is deliberately a probe, not an acceptance: the plugin has no first-class way
  // to carry a coverage report (the engine's `adjudication_submit` has no
  // `coverage` parameter), so today the only channel is a field on a forwarded
  // document. If the engine ever grows a real one, flip this to assert the anchor
  // succeeds and delete the sentence above.
  const withoutReport = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'tech-test',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    documents,
    findings,
  }, {})
  assert.equal(withoutReport.unanchored, 2, 'with no coverage data at all, NEITHER finding can be anchored')
  assert.equal(withoutReport.coverage.reviewed, 0)
  assert.match(withoutReport.unanchoredDetails[0].detail, /没有提供/u)
  assert.match(withoutReport.unanchoredDetails[0].detail, /不予锚定/u)
})

// ---------------------------------------------------------------------------
// The engine boundary: the domain locator must SURVIVE the trip
// ---------------------------------------------------------------------------

console.log('\nthe engine boundary — the domain locator must arrive intact')

// ADDED (t20). Everything above this point tests the domain in isolation, with
// `anchor.verify` called directly. That is not enough, and the reason is
// historical: `recomputeAnchor` in `index.js` USED TO rebuild the claim from the
// engine's generic anchor vocabulary, producing
// `{kind, path, locator:{start, startLine, end, endLine}, excerpt}` and dropping
// `finding.locator` entirely. A domain-shaped locator — `{caseId, line, branch}`
// here, `{moduleId, targetId}` in architecture, `{operator, backend, dtype,
// shapeBranch}` in operator-design — never reached the verifier, so sixteen of
// the nineteen domains would have scored zero coverage forever.
//
// That engine behaviour is GONE. `index.js:734` ("CHANGED (t17, second pass)")
// passes the caller's `locator` through VERBATIM and folds the top-level
// `start`/`end` in ONLY when the caller supplied no locator at all — so a
// verifier's own "empty claim" detection still works, and no engine-invented key
// is ever mixed into a domain's shape. The two probes below are what keep that
// true: they are the only assertions in this file that cross the engine boundary,
// and a refactor that reintroduces locator reconstruction turns them red.

await testAsync('the engine hands this domain\'s verifier the caller\'s locator VERBATIM, not a rebuilt one', async () => {
  const ctx = createPluginContext()
  const locator = {
    kind: 'case-and-covered-line',
    path: 'src/api/handler.ts',
    caseId: 'c-1',
    line: 4,
    branch: 'bad-request',
  }

  // `adjudication_anchor` returns the claim the engine actually constructed, so
  // this reads the boundary itself instead of inferring it from a verdict.
  const anchored = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'tech-test',
    path: 'src/api/handler.ts',
    excerpt: "return reject(400, 'bad request')",
    locator,
    documents: [{ path: 'src/api/handler.ts', content: "export function handler(req) {\n  if (!req.body) {\n    return reject(400, 'bad request')\n  }\n}\n" }],
  }, {})

  assert.equal(anchored.via, 'anchorVerifier', 'the engine must route through the pack anchorVerifier')
  assert.deepEqual(anchored.claim.locator, locator,
    'the locator must arrive byte-for-byte; a rebuilt {start,startLine,end,endLine} would prove the old defect is back')
  assert.equal(anchored.claim.kind, 'case-and-covered-line')
  assert.equal(anchored.claim.path, 'src/api/handler.ts')
})

await testAsync('a finding carrying this domain\'s locator is anchored THROUGH adjudication_submit and counted in coverage', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const documents = Object.entries(happy.input.payload.source)
    .map(([path, entry]) => ({ path, content: entry.lines.join('\n') }))

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'tech-test',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'tech-test',
    target: 'fixture happy-path',
    // CHANGED (t23): the coverage report travels on the forwarded documents. It has
    // to be here: F2 made check 2 fail-closed, so a submission with no coverage data
    // can no longer anchor a coverage-gap claim — which is the point of the change.
    documents: documents.map((document) => ({ ...document, coverage: happy.input.payload.coverage })),
    findings: [{
      id: 'f-located',
      path: 'src/api/handler.ts',
      excerpt: "return reject(400, 'bad request')",
      evidence: "return reject(400, 'bad request')",
      // The domain's own locator, and NO top-level `start`/`end`: under the old
      // engine this claim would have carried an empty locator and the finding
      // would have fallen back to a text search. The tier below is what proves
      // the locator arrived and DROVE the verdict rather than merely riding along.
      locator: {
        kind: 'case-and-covered-line',
        path: 'src/api/handler.ts',
        caseId: 'c-1',
        line: 4,
        branch: 'bad-request',
        startLine: 4,
      },
      severity: 'high',
      message: 'req.body 的空值分支没有任何用例覆盖',
      defended: true,
    }],
  }, {})

  assert.equal(submitted.anchorVia, 'anchorVerifier')
  assert.equal(submitted.unanchored, 0, 'a finding that carries a locator the verifier can use must anchor')
  assert.equal(submitted.findings.length, 1)
  const finding = submitted.findings[0]
  assert.equal(finding.anchored, true)
  assert.equal(finding.anchorTier, 'declared-locator',
    'the caller declared line 4 inside the locator, so the verifier confirms a DECLARED position instead of re-deriving one')
  assert.ok(TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier))
  // The engine reports which "where" the domain produced; for a locator-shaped
  // domain that is the caller's own locator, not a line range.
  assert.equal(finding.anchorLocator.caseId, 'c-1')
  assert.equal(finding.anchorLocator.branch, 'bad-request')

  assert.equal(submitted.coverage.total, new Set(happy.expect.paths).size, 't51: the denominator is the plan admission measured in the unit coverage() reports (distinct paths, not candidates)')
  assert.equal(submitted.coverage.reviewed, 1, 'the anchored path must be counted as reviewed')
  assert.equal(submitted.coverage.coverageRate, Number((1 / new Set(happy.expect.paths).size).toFixed(4)))
  assert.equal(submitted.coverage.totalSource, 'plan')
})

await testAsync('adjudication_activate registers this domain\'s own tool names', async () => {
  const ctx = createPluginContext()
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.ok(listed.count >= 1)
  assert.ok(listed.domains.some((item) => item.id === 'tech-test'), 'tech-test must be in the registry')
  const directory = listed.directory
  assert.ok(directory !== null, 'the directory report must be present once directory domains exist')
  assert.ok(directory.loaded.includes('tech-test'), `loaded: ${directory.loaded.join(', ')}`)
  assert.deepEqual(directory.problems.filter((entry) => entry.id === 'tech-test'), [])

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'tech-test' }, {})
  assert.equal(activated.ok, true, activated.summary)
  for (const name of ['adjudicate_tech_test', 'adjudicate_tech_test_plan', 'adjudicate_tech_test_rules']) {
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
