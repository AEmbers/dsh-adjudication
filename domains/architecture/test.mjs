/**
 * architecture — domain end-to-end test (contract v2, `test.mjs`).
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
 *    section is produced by `anchor.verify` on a real locator first — the
 *    plugin's `adjudication_submit` recomputes anchors itself, so an assertion
 *    built on a hand-written `anchored: true` would prove nothing.
 * 4. It never hard-codes "architecture is the only domain in `domains/`".
 *
 * Usage: `node domains/architecture/test.mjs`
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
import anchor, { findCycle, findPath } from './anchor.js'
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

console.log('\narchitecture domain — contract v2 end-to-end')
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

test('the pack id matches the directory name, so the tool names are not ghosts', () => {
  assert.equal(pack.id, 'architecture')
  assert.equal(here.split(/[\\/]/u).pop(), pack.id)
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('architecture')
  assert.equal(declared.format, 'module-graph-and-adr')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, 'module-and-adr')
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable',
    'this anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('precision-first and fact-checker agree, because one of the two would otherwise be a lie', () => {
  assert.equal(pack.lossOrientation, 'precision-first')
  assert.equal(pack.criticism.kind, 'fact-checker')
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
  }
  assert.deepEqual(problems, [], problems.join('; '))
})

test('no rule document claims expert validation', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    assert.doesNotMatch(text, /expert-validated|已通过专家|专家审定/u, `${file} must not claim expert validation`)
  }
})

test('every rule document declares a title and matches at least one file pattern', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const front = text.split('---')[1] ?? ''
    assert.match(front, /^name: [a-z][a-z0-9-]*$/mu, `${file} needs a kebab-case name`)
    assert.match(front, /^match:\n(\s+- ".*"\n?)+/mu, `${file} needs a non-empty match list`)
    assert.match(front, /^title: .+$/mu, `${file} needs a human title`)
  }
})

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'proto-only', match: ['**/*.proto'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['src/api/handler.ts'])
  assert.deepEqual(selected.injected.map((rule) => rule.name).sort(), ['any'])
  const both = selectRules([
    { name: 'proto-only', match: ['**/*.proto'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['proto/api.proto'])
  assert.deepEqual(both.injected.map((rule) => rule.name).sort(), ['any', 'proto-only'])
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  assert.ok(FIXTURES.has('cycle'), 'the documented fourth fixture for this format')
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
  assert.equal(inputFormatFor('architecture').bounded, true)
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate([], {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ adrs: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ modules: [], adrs: {} }, {}), /E_INPUT_FORMAT/u)
  // An EMPTY manifest is NOT malformed: "nothing to review" is a legitimate answer.
  assert.doesNotThrow(() => source.enumerate({ modules: [], adrs: [] }, {}))
  // `adrs` is optional: a graph with no decision archive is still a graph.
  assert.doesNotThrow(() => source.enumerate({ modules: [] }, {}))
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

test('boundary 4 — the cycle fixture is a graph with a real loop, and its edges are admitted', () => {
  const { enumerated, result } = runP0P1('cycle')
  const expectation = fixture('cycle').expect
  assert.equal(enumerated.candidates.length, expectation.candidates)
  assert.equal(result.selected.length, expectation.admitted)
  assert.deepEqual(result.selected.map((entry) => entry.path).sort(), [...expectation.paths].sort())
})

test('a dangling edge is reported, not silently dropped, and never becomes a candidate', () => {
  const enumerated = source.enumerate({
    modules: [{ id: 'a', path: 'src/a.ts', dependsOn: ['ghost'] }],
    adrs: [],
  }, {})
  assert.equal(enumerated.candidates.length, 0, 'an edge to a module nobody declares is not an edge')
  assert.equal(enumerated.excluded.length, 1)
  assert.equal(enumerated.excluded[0].id, 'a -> ghost')
  assert.match(enumerated.excluded[0].reason, /悬空边/u)
})

test('a module without a path is reported rather than given a fabricated one', () => {
  const enumerated = source.enumerate({
    modules: [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', path: 'src/b.ts', dependsOn: [] },
    ],
    adrs: [],
  }, {})
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(enumerated.excluded[0].id, 'a')
  assert.match(enumerated.excluded[0].reason, /没有给出实现路径/u)
})

test('an ADR affecting a module the manifest does not have is reported', () => {
  const enumerated = source.enumerate({
    modules: [{ id: 'a', path: 'src/a.ts', dependsOn: [] }],
    adrs: [{ id: 'ADR-9', status: 'accepted', affects: ['a', 'stranger'] }],
  }, {})
  assert.equal(enumerated.candidates.length, 1, 'the (ADR, a) pair is still a candidate')
  assert.equal(enumerated.excluded.length, 1)
  assert.equal(enumerated.excluded[0].id, 'ADR-9 -> stranger')
})

test('an ADR that declares no affected module yields a note, not a candidate', () => {
  const enumerated = source.enumerate({
    modules: [{ id: 'a', path: 'src/a.ts', dependsOn: [] }],
    adrs: [{ id: 'ADR-0', status: 'accepted', affects: [] }],
  }, {})
  assert.equal(enumerated.candidates.length, 0)
  assert.ok(enumerated.notes.some((note) => /ADR "ADR-0" 没有声明影响任何模块/u.test(note)))
})

test('a duplicated module id makes its edges unenumerable — refused, not resolved by taking the first', () => {
  const enumerated = source.enumerate({
    modules: [
      { id: 'api', path: 'src/api/handler.ts', dependsOn: ['core'] },
      { id: 'api', path: 'legacy/api/handler.ts', dependsOn: ['core'] },
      { id: 'core', path: 'src/core/engine.ts', dependsOn: [] },
    ],
    adrs: [{ id: 'ADR-1', status: 'accepted', affects: ['api'] }],
  }, {})
  assert.equal(enumerated.candidates.length, 0, 'the same id naming two implementations identifies no edge')
  assert.equal(enumerated.excluded.length, 3, 'two out-edges plus one (ADR, module) pair')
  for (const item of enumerated.excluded) {
    assert.match(item.reason, /出现了多次/u)
  }
  assert.ok(enumerated.notes.some((note) => /重复的 id：api/u.test(note)))
})

test('an edge whose TARGET id is duplicated is refused too, not pointed at the first namesake', () => {
  const enumerated = source.enumerate({
    modules: [
      { id: 'api', path: 'src/api/handler.ts', dependsOn: ['core'] },
      { id: 'core', path: 'src/core/engine.ts', dependsOn: [] },
      { id: 'core', path: 'legacy/core/engine.ts', dependsOn: [] },
    ],
    adrs: [],
  }, {})
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(enumerated.excluded[0].id, 'api -> core')
  assert.match(enumerated.excluded[0].reason, /"core" 在清单里出现了多次/u)
})

test('candidate text is the canonical edge rendering, and `path` stays a real module path', () => {
  const { enumerated } = runP0P1('happy-path')
  const edge = enumerated.candidates.find((candidate) => candidate.text === 'api -> core')
  assert.ok(edge !== undefined, 'the edge must be rendered canonically, not as prose')
  assert.deepEqual(edge.locator, {
    kind: 'dependency-edge',
    path: 'src/api/handler.ts',
    moduleId: 'api',
    targetId: 'core',
    findingKind: 'edge',
  })
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'a synthetic id must never leak into candidate.path')
    assert.ok(/^[a-z]/u.test(candidate.path), 'the path stays the module file the gate globs')
  }
})

test('candidate ids are unique', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('a candidate larger than the ceiling is removed by the too-large predicate', () => {
  const result = gate([{ path: 'src/huge.ts', bytes: 4096 }], { maxFileBytes: 1024 })
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

test('the module resolver normalises separators and reads nothing the engine refuses to forward', () => {
  assert.equal(pack.bundleKey.resolve({ path: 'src/api/handler.ts' }), 'src/api/handler.ts')
  assert.equal(pack.bundleKey.resolve({ path: 'src\\api\\handler.ts' }), 'src/api/handler.ts')
  // index.js `toCandidates()` copies a fixed field set, so a resolver that wanted
  // `meta` would silently see `undefined` — which would put every edge in its own
  // bundle while looking correct in unit tests that pass the raw candidate.
  assert.equal(pack.bundleKey.resolve({ path: 'src/api/handler.ts', meta: { moduleId: 'WRONG' } }), 'src/api/handler.ts')
})

test('all the edges of one module really land in the same bundle', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: pack.bundleKey.resolve(entry) }))
  const byKey = new Map()
  for (const entry of keyed) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, [])
    byKey.get(entry.key).push(entry)
  }
  assert.deepEqual([...byKey.keys()].sort(), [...fixture('happy-path').expect.bundleKeys].sort())
  assert.equal(byKey.get('src/api/handler.ts').length, 4,
    'three out-edges plus one (ADR, module) pair must share the module bundle')
  assert.equal(byKey.get('src/core/engine.ts').length, 3)
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
      assert.equal(typeof verdict.detail, 'string')
      assert.ok(verdict.detail.length > 0, 'every unanchored verdict must explain itself')
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
    })
  }
}

// --- the graph checks that make this verifier more than a text search ---------

const GRAPH_MODULES = [
  { id: 'api', path: 'src/api/handler.ts', dependsOn: ['core'], layer: 'application' },
  { id: 'core', path: 'src/core/engine.ts', dependsOn: ['util'], layer: 'domain' },
  { id: 'util', path: 'src/util/strings.ts', dependsOn: [], layer: 'infrastructure' },
]
const GRAPH_ADRS = [
  { id: 'ADR-0001', title: 'Layers', status: 'accepted', decision: '外层指向内层。', affects: ['core'] },
  { id: 'ADR-0009', title: 'Old cache', status: 'superseded', decision: '已移除。', affects: ['api'] },
]
/** A graph that really contains a loop: `a -> b -> a`. */
const LOOP_MODULES = [
  { id: 'a', path: 'src/a.ts', dependsOn: ['b'], layer: 'application' },
  { id: 'b', path: 'src/b.ts', dependsOn: ['a'], layer: 'domain' },
]
/** A graph with one edge that points backwards through the layer order. */
const REVERSE_MODULES = [
  { id: 'store', path: 'src/infra/store.ts', dependsOn: ['api'], layer: 'infrastructure' },
  { id: 'api', path: 'src/api/handler.ts', dependsOn: [], layer: 'application' },
]
const LAYERS = ['application', 'domain', 'infrastructure']

const EDGE_CLAIM = (locatorOverrides = {}, excerpt = 'api -> core') => ({
  kind: 'module-and-adr',
  path: 'src/api/handler.ts',
  locator: {
    kind: 'dependency-edge',
    path: 'src/api/handler.ts',
    moduleId: 'api',
    targetId: 'core',
    findingKind: 'edge',
    ...locatorOverrides,
  },
  excerpt,
})
const SUBJECT = (overrides = {}) => ({ modules: GRAPH_MODULES, adrs: GRAPH_ADRS, ...overrides })

test('the edge is recomputed from the graph, not merely matched as a string', () => {
  const verdict = anchor.verify(EDGE_CLAIM(), SUBJECT())
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'recomputed-unique')
  assert.equal(verdict.locator.kind, 'dependency-edge')
  assert.equal(verdict.locator.moduleId, 'api')
  assert.equal(verdict.start, null, 'this domain has no line positions — the non-empty locator is what anchors it')
})

test('an edge the graph does not contain is refused, even though the two ids both exist', () => {
  const verdict = anchor.verify(
    EDGE_CLAIM({ moduleId: 'util', targetId: 'api' }, 'util -> api'),
    SUBJECT(),
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /dependsOn 是 \[\]/u)
})

test('a transposed edge is a DIFFERENT edge, not a sloppy spelling of the same one', () => {
  const verdict = anchor.verify(
    EDGE_CLAIM({ moduleId: 'core', targetId: 'api' }, 'core -> api'),
    SUBJECT(),
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /依赖图里没有这条边/u)
})

test('a quoted edge that does not match the recomputed rendering is refused before any graph walk', () => {
  const verdict = anchor.verify(EDGE_CLAIM({}, 'src/api/handler.ts -> src/core/engine.ts'), SUBJECT())
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match', 'the anchor is the module ID, not the file path')
})

test('a cycle claim is recomputed by walking the graph, and a missing loop contradicts it', () => {
  const loop = anchor.verify(
    { kind: 'module-and-adr', path: 'src/a.ts', locator: { moduleId: 'a', targetId: 'b', findingKind: 'cycle' }, excerpt: 'a -> b' },
    { modules: LOOP_MODULES, adrs: [] },
  )
  assert.equal(loop.status, 'anchored')
  assert.equal(loop.tier, 'recomputed-unique')
  assert.match(loop.detail, /确认存在环/u)
  assert.deepEqual(loop.locator.cycle, ['a', 'b', 'a'])

  // The ACYCLIC graph: the same-shaped claim must fail, because the edge exists
  // but no path leads back. "There is an edge" is not "there is a loop".
  const noLoop = anchor.verify(
    EDGE_CLAIM({ moduleId: 'api', targetId: 'core', findingKind: 'cycle' }, 'api -> core'),
    SUBJECT(),
  )
  assert.equal(noLoop.status, 'unanchored', 'the edge is real but no cycle passes through it')
  assert.equal(noLoop.tier, 'locator-mismatch')
  assert.match(noLoop.detail, /没有经过 "api" 的环/u)
})

test('a reverse-layer claim is checked against the declared layer order, not assumed', () => {
  const reverse = anchor.verify(
    { kind: 'module-and-adr', path: 'src/infra/store.ts', locator: { moduleId: 'store', targetId: 'api', findingKind: 'reverse-layer' }, excerpt: 'store -> api' },
    { modules: REVERSE_MODULES, adrs: [], layers: LAYERS },
  )
  assert.equal(reverse.status, 'anchored', 'infrastructure -> application points outward, so it IS reverse')
  assert.match(reverse.detail, /确实是反向依赖/u)

  const allowed = anchor.verify(
    EDGE_CLAIM({ moduleId: 'api', targetId: 'core', findingKind: 'reverse-layer' }, 'api -> core'),
    SUBJECT({ layers: LAYERS }),
  )
  assert.equal(allowed.status, 'unanchored', 'application -> domain points inward, so it is NOT reverse')
  assert.equal(allowed.tier, 'locator-mismatch')
  assert.match(allowed.detail, /允许的方向/u)
})

test('"no layer order supplied" refuses rather than guessing the direction', () => {
  const verdict = anchor.verify(
    { kind: 'module-and-adr', path: 'src/infra/store.ts', locator: { moduleId: 'store', targetId: 'api', findingKind: 'reverse-layer' }, excerpt: 'store -> api' },
    { modules: REVERSE_MODULES, adrs: [] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /没有提供层次声明/u)
})

test('an ADR claim is checked against affects, and a superseded claim against the status', () => {
  const affects = anchor.verify(
    { kind: 'module-and-adr', path: 'src/api/handler.ts', locator: { moduleId: 'api', adrId: 'ADR-0001' }, excerpt: 'ADR-0001 -> api' },
    SUBJECT(),
  )
  assert.equal(affects.status, 'unanchored')
  assert.equal(affects.tier, 'locator-mismatch')
  assert.match(affects.detail, /affects 是 \[core\]/u)

  const superseded = anchor.verify(
    { kind: 'module-and-adr', path: 'src/api/handler.ts', locator: { moduleId: 'api', adrId: 'ADR-0009', findingKind: 'adr-superseded' }, excerpt: 'ADR-0009 -> api' },
    SUBJECT(),
  )
  assert.equal(superseded.status, 'anchored')
  assert.match(superseded.detail, /superseded/u)

  const notSuperseded = anchor.verify(
    { kind: 'module-and-adr', path: 'src/core/engine.ts', locator: { moduleId: 'core', adrId: 'ADR-0001', findingKind: 'adr-superseded' }, excerpt: 'ADR-0001 -> core' },
    SUBJECT(),
  )
  assert.equal(notSuperseded.status, 'unanchored', 'the archive says accepted, so the claim is contradicted')
  assert.equal(notSuperseded.tier, 'locator-mismatch')
  assert.match(notSuperseded.detail, /与归档矛盾/u)
})

test('a duplicated ADR id is ambiguous, and the archive titles are handed back instead of a pick', () => {
  const verdict = anchor.verify(
    { kind: 'module-and-adr', path: 'src/api/handler.ts', locator: { moduleId: 'api', adrId: 'ADR-0009', findingKind: 'adr-superseded' }, excerpt: 'ADR-0009 -> api' },
    {
      modules: GRAPH_MODULES,
      adrs: [
        { id: 'ADR-0009', title: 'Old cache', status: 'superseded', decision: '已移除。', affects: ['api'] },
        { id: 'ADR-0009', title: 'Old retry', status: 'accepted', decision: '另一条决策。', affects: ['api'] },
      ],
    },
  )
  assert.equal(verdict.status, 'unanchored', 'two decisions share the number, so "ADR-0009" names neither')
  assert.equal(verdict.tier, 'relocation-ambiguous')
  assert.deepEqual(verdict.ambiguousIn, ['Old cache', 'Old retry'])
})

test('"no decision archive" refuses — it must never read as "the decision holds"', () => {  const verdict = anchor.verify(
    { kind: 'module-and-adr', path: 'src/api/handler.ts', locator: { moduleId: 'api', adrId: 'ADR-0009', findingKind: 'adr-superseded' }, excerpt: 'ADR-0009 -> api' },
    { modules: GRAPH_MODULES },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /没有提供 ADR 归档/u)
})

test('an unknown findingKind is refused rather than treated as a generic edge', () => {
  const verdict = anchor.verify(EDGE_CLAIM({ findingKind: 'coupling-smell' }), SUBJECT())
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /未知的 findingKind/u)
})

test('a module id the manifest does not declare is refused, and the existing ids are listed', () => {
  const verdict = anchor.verify(EDGE_CLAIM({ moduleId: 'src' }), SUBJECT())
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /api, core, util/u)
})

test('a claim with neither targetId nor adrId is neither an edge nor a decision', () => {
  const verdict = anchor.verify(
    { kind: 'module-and-adr', path: 'src/api/handler.ts', locator: { moduleId: 'api' }, excerpt: 'api -> core' },
    SUBJECT(),
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /既不是边也不是决策/u)
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'src/api/handler.ts', locator: {}, excerpt: 'api -> core' },
    SUBJECT(),
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('an empty excerpt is refused: there is nothing to verify, so nothing is verified', () => {
  const verdict = anchor.verify(EDGE_CLAIM({}, '   \n\n  '), SUBJECT())
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'empty-excerpt')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'module-and-adr' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'module-and-adr', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

test('whitespace in the quoted edge is tolerated, but a renamed module is not', () => {
  const tolerated = anchor.verify(EDGE_CLAIM({}, '  api   ->    core  '), SUBJECT())
  assert.equal(tolerated.status, 'anchored', 'indentation and spacing carry no meaning here')
  const renamed = anchor.verify(EDGE_CLAIM({}, 'src/api/handler.ts -> src/core/engine.ts'), SUBJECT())
  assert.equal(renamed.status, 'unanchored', 'the anchor is the module ID, not the file path')
  assert.equal(renamed.tier, 'no-match')
})

test('the exported graph helpers are bounded, so a pathological graph cannot hang the verifier', () => {
  const chain = new Map()
  for (let index = 0; index < 500; index += 1) chain.set(`m${index}`, [`m${index + 1}`])
  assert.equal(findPath(chain, 'm0', 'm499', 32), null, 'beyond the bound means "not proven", not a partial path')
  assert.deepEqual(findPath(chain, 'm0', 'm5', 32), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
  assert.equal(findCycle(chain, 'm0'), null, 'a straight chain has no loop')
  const ring = new Map([['x', ['y']], ['y', ['z']], ['z', ['x']]])
  assert.deepEqual(findCycle(ring, 'x'), ['x', 'y', 'z', 'x'])
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['src/api/handler.ts'],
  bundle: { key: 'src/api/handler.ts', paths: ['src/api/handler.ts'], rules: ['cyclic-dependency'] },
  ruleText: '<rules path="src/api/handler.ts">\n环依赖：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    {
      id: 'f1',
      path: 'src/api/handler.ts',
      evidence: 'api -> core',
      message: 'api 与 core 之间存在环依赖',
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
  assert.doesNotMatch(P6.system, /本捆覆盖的模块路径/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /环依赖：/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /环依赖：/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('P4 names the domain tools it is allowed to call', () => {
  for (const tool of evidence.tools) {
    assert.match(P4.system, new RegExp(tool.name, 'u'), `P4 must name ${tool.name}`)
  }
})

test('both prompts repeat the anchor law: quote the text, never the line number', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /行号/u)
    assert.match(text, /anchor\.excerpt|摘录/iu)
  }
})

test('precision-first is stated in both prompts, and flipping it changes the text', () => {
  assert.match(P4.system, /precision-first/u)
  assert.match(P6.system, /precision-first/u)
  const flipped = prompts.review({ ...reviewContext, orientation: 'recall-first' })
  assert.notEqual(flipped.system, P4.system)
  assert.match(flipped.system, /recall-first/u)
  const flippedVerify = prompts.verify({ ...verifyContext, orientation: 'recall-first' })
  assert.match(flippedVerify.system, /recall-first/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空不是失败/u)
})

test('the rule provenance is stated to the model, so no prompt implies expert validation', () => {
  assert.match(P4.system, /needs-expert-review/u)
  assert.doesNotMatch(P4.system, /已经过专家|专家审定/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const TOOL_MODULES = [
  { id: 'api', path: 'src/api/handler.ts', dependsOn: ['core'], layer: 'application' },
  { id: 'core', path: 'src/core/engine.ts', dependsOn: ['util'], layer: 'domain' },
  { id: 'util', path: 'src/util/strings.ts', dependsOn: [], layer: 'infrastructure' },
]
const TOOL_ADRS = [
  { id: 'ADR-0001', title: 'Layers', status: 'accepted', decision: '外层指向内层。', affects: ['core'] },
  { id: 'ADR-0009', title: 'Old cache', status: 'superseded', decision: '已移除。', affects: ['api'] },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('module_edges lists out and in edges, and marks the direction when layers are given', async () => {
  const tool = toolByName('module_edges')
  const result = await tool.execute(
    { moduleId: 'core', modules: TOOL_MODULES, layers: ['application', 'domain', 'infrastructure'] },
    {},
  )
  assert.deepEqual(result.items.map((item) => `${item.direction}:${item.from}->${item.to}`), ['out:core->util', 'in:api->core'])
  assert.equal(result.items[0].reverse, false, 'domain -> infrastructure points inward')
  assert.equal(result.truncated, false)
  assert.equal(typeof result.provenance, 'string')
  assert.ok(result.provenance.length > 0)
})

await testAsync('module_edges caps its item count and says when it cut', async () => {
  const tool = toolByName('module_edges')
  const many = Array.from({ length: 200 }, (_, index) => ({
    id: `m${index}`,
    path: `src/m${index}.ts`,
    dependsOn: [`m${(index + 1) % 200}`],
  }))
  const result = await tool.execute({ modules: many }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('graph_path finds a directed path, and reports absence as a conclusion rather than an error', async () => {
  const tool = toolByName('graph_path')
  const found = await tool.execute({ from: 'api', to: 'util', modules: TOOL_MODULES }, {})
  assert.deepEqual(found.items.map((item) => item.moduleId), ['api', 'core', 'util'])
  assert.equal(found.truncated, false)
  assert.match(found.provenance, /找到路径：api → core → util/u)

  const missing = await tool.execute({ from: 'util', to: 'api', modules: TOOL_MODULES }, {})
  assert.deepEqual(missing.items, [])
  assert.equal(missing.truncated, false)
  assert.match(missing.provenance, /没有从 "util" 到 "api"/u)
})

await testAsync('adr_lookup falls back from exact to substring and filters by status', async () => {
  const tool = toolByName('adr_lookup')
  const exact = await tool.execute({ id: 'ADR-0001', adrs: TOOL_ADRS }, {})
  assert.deepEqual(exact.items.map((item) => item.id), ['ADR-0001'])
  assert.deepEqual(exact.items[0].affects, ['core'])

  const partial = await tool.execute({ id: 'ADR', adrs: TOOL_ADRS }, {})
  assert.deepEqual(partial.items.map((item) => item.id), ['ADR-0001', 'ADR-0009'])

  const filtered = await tool.execute({ adrs: TOOL_ADRS, status: 'superseded' }, {})
  assert.deepEqual(filtered.items.map((item) => item.id), ['ADR-0009'])
})

await testAsync('adr_lookup caps its item count and reports the cap', async () => {
  const tool = toolByName('adr_lookup')
  const many = Array.from({ length: 100 }, (_, index) => ({ id: `ADR-${index}`, status: 'accepted', affects: [] }))
  const result = await tool.execute({ adrs: many }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('a request with no context at all is refused, not answered with "nothing found"', async () => {
  assert.throws(() => toolByName('module_edges').execute({}, {}), /缺少 `modules`/u)
  assert.throws(() => toolByName('graph_path').execute({ from: 'a', to: 'b' }, {}), /缺少 `modules`/u)
  assert.throws(() => toolByName('adr_lookup').execute({}, {}), /缺少 `adrs`/u)
})

await testAsync('a request naming an absent module fails loudly with the available ids', async () => {
  assert.throws(() => toolByName('graph_path').execute({ from: 'ghost', to: 'api', modules: TOOL_MODULES }, {}), /依赖图里没有模块 "ghost"/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('architecture', 'graph_path'), 'adjudicate_architecture_evidence_graph_path')
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
                path: 'src/api/handler.ts',
                evidence: 'api -> core',
                message: 'api 与 core 之间存在环依赖',
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
  assert.match(requests[0].prompt[0].text, /架构设计/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /行号/u, 'the anchor law must survive into the child prompt')
})

await testAsync('with no subagent service the reasoner says so instead of inventing findings', async () => {
  const { createReasoner } = await import('../../lib/reasoner.js')
  const reasoner = createReasoner({}, { maxRounds: 8, maxFindings: 10 })
  const outcome = await reasoner.run({ pack: { ...pack, reviewPrompts: prompts }, target: 't', bundles: [], budget: createBudget({}), getBudget: () => createBudget({}), onCharge: () => {} })
  assert.equal(outcome.mode, 'none')
  assert.deepEqual(outcome.findings, [])
})

// ---------------------------------------------------------------------------
// P6 / P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(8, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 8)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, 0.25)
  assert.equal(proof.complete, false)
  assert.equal(coverage(8, [{ path: 'a' }], { requireComplete: true }).required, true)
})

test('precision-first drops what the critique could not defend, and keeps only the defended', () => {
  const panel = runCritiquePanel([
    { id: 'undefended', path: 'src/api/handler.ts', start: 1, severity: 'high', evidence: '', defended: false },
    { id: 'defended', path: 'src/api/handler.ts', start: 2, severity: 'high', evidence: 'api -> core', defended: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['defended'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['undefended'])
  assert.equal(panel.kind, 'fact-checker')
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  // The anchors are REAL: they come from `anchor.verify` over the fixture's own
  // graph, not from a hand-written `anchored: true`.
  const happy = fixture('happy-path')
  const subject = { modules: happy.input.payload.modules, adrs: happy.input.payload.adrs }
  const claim = (excerpt) => ({
    kind: 'module-and-adr',
    path: 'src/api/handler.ts',
    locator: { kind: 'dependency-edge', path: 'src/api/handler.ts', moduleId: 'api', targetId: 'core', findingKind: 'edge' },
    excerpt,
  })
  const good = anchor.verify(claim('api -> core'), subject)
  const bad = anchor.verify(claim('api -> util'), subject)
  assert.equal(good.status, 'anchored')
  assert.equal(bad.status, 'unanchored')

  const anchored = [good, bad].filter((verdict) => verdict.status === 'anchored')
  assert.equal(anchored.length, 1)
  const proof = coverage(2, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.5, 'the unanchored path must not be counted as reviewed')
  assert.equal(proof.complete, false)
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel(
    [{ id: 'f', path: 'src/api/handler.ts', start: 1, severity: 'high', evidence: 'api -> core', defended: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind },
  )
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 8, excluded: 0, bundles: 3 },
    findings: panel.kept,
    coverageProof: coverage(8, panel.kept),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'architecture')
  assert.equal(built.lossOrientation, 'precision-first')
  assert.equal(built.criticismKind, 'fact-checker')
  assert.equal(built.coverage.total, 8)
  assert.equal(built.coverage.reviewed, 1)
  assert.equal(built.coverage.coverageRate, 0.125)
  assert.equal(built.generatedAt, null, 'a deterministic engine must not stamp wall-clock time')
})

// ---------------------------------------------------------------------------
// The domain as loaded from disk
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

/**
 * Every domain directory that actually exists on disk, derived from the LIVE
 * directory listing using the loader's own discovery rule.
 *
 * WHY THIS IS DERIVED AND NOT HARD-CODED: a hard-coded list would assert "how
 * many domains exist TODAY", not "what the rule is" — and would go red the
 * moment a sibling created their directory, for a reason unrelated to this
 * domain.
 */
const DOMAIN_DIRECTORY_IDS = readdirSync(join(here, '..'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/u.test(entry.name))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(here, '..', name, 'index.js')))
  .sort()

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
  const loaded = await loadDomain(io, { id: 'architecture', dir: 'domains/architecture' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'modules-and-decisions')
  assert.equal(assembled.anchorVerifier.kind, 'module-and-adr')
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
  assert.ok(discovery.found.some((entry) => entry.id === 'architecture'), 'this domain must be discovered')
  const foundIds = new Set(discovery.found.map((entry) => entry.id))
  for (const entry of discovery.skipped) {
    const reason = typeof entry.reason === 'string' ? entry.reason : entry.problems?.join('; ')
    assert.equal(typeof reason === 'string' && reason !== '', true, `scan-level skip "${entry.id}" must carry a reason`)
    assert.equal(foundIds.has(entry.id), false, `"${entry.id}" cannot be both found and skipped`)
  }

  const result = await loadDomains(io, { root: 'domains' })
  assert.deepEqual(result.problems.filter((entry) => entry.id === 'architecture'), [], JSON.stringify(result.problems))
  assertEveryDirectoryAccountedFor(result)
  assert.equal(result.packs.some((item) => item.id === 'architecture'), true, 'this domain must load')
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
    domain: 'architecture',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'modules-and-decisions')
  assert.equal(plan.candidateSet.inputFormat, 'module-graph-and-adr')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the v2 object form must actually take effect')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.derived, happy.expect.admitted)
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), [...happy.expect.bundleKeys].sort())
  const biggest = plan.bundles.find((item) => item.key === 'src/api/handler.ts')
  assert.equal(biggest.paths.length, 4, 'grouping must be real, not one candidate per bundle')
  assert.equal(plan.criticism.kind, 'fact-checker')
  assert.match(plan.summary, /复核者：fact-checker/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'architecture',
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
    domain: 'architecture',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  // CHANGED (t20): this block used to record an ENGINE defect. `recomputeAnchor`
  // in `index.js` used to rebuild the claim from the engine's generic anchor
  // vocabulary (`{start, startLine, end, endLine}`), dropping `finding.locator`
  // — so a graph-shaped locator (moduleId / targetId / adrId / findingKind)
  // never reached this domain's own verifier.
  //
  // That engine behaviour is GONE: `index.js:734` ("CHANGED (t17, second pass)")
  // passes the caller's `locator` through VERBATIM and folds the top-level
  // `start`/`end` in ONLY when no locator was supplied. The finding below is
  // therefore unanchored for a DIFFERENT reason than the old comment gave: it
  // supplies no locator at all, so there is no edge or decision to recompute.
  //
  // (That the locator now ARRIVES is asserted one test down, directly against the
  // claim the engine built. What still cannot anchor through `adjudication_submit`
  // is a claim that DOES carry the locator — see the GAP note there.)
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'architecture',
    target: 'fixture happy-path',
    documents: [{ path: 'src/api/handler.ts', content: 'api -> core' }],
    findings: [
      {
        id: 'f1',
        path: 'src/api/handler.ts',
        excerpt: 'api -> core',
        anchored: true,
        start: 1,
        severity: 'high',
        message: 'api 与 core 之间存在环依赖',
        evidence: 'api -> core',
        defended: true,
      },
    ],
  }, {})

  assert.equal(submitted.unanchored, 1,
    'a finding the engine could not recompute must NOT be counted as an effective finding, whatever the caller claimed')
  assert.equal(submitted.coverage.reviewed, 0, 'nothing was anchored, so nothing counts as reviewed')
  assert.equal(submitted.coverage.complete, false)
  assert.equal(submitted.coverage.required, false, 'precision-first does not demand a complete proof')
  assert.equal(submitted.criticismKind, 'fact-checker')
  // `plan` is used only to pin the denominator the engine would have had.
  assert.equal(plan.gate.admitted, happy.expect.admitted)
})

await testAsync('the domain-local half anchors correctly when the locator it declares is supplied', async () => {
  const happy = fixture('happy-path')
  const subject = { modules: happy.input.payload.modules, adrs: happy.input.payload.adrs }
  const claim = (excerpt, locatorOverrides = {}) => ({
    kind: 'module-and-adr',
    path: 'src/api/handler.ts',
    locator: {
      kind: 'dependency-edge',
      path: 'src/api/handler.ts',
      moduleId: 'api',
      targetId: 'core',
      findingKind: 'edge',
      ...locatorOverrides,
    },
    excerpt,
  })

  const anchored = anchor.verify(claim('api -> core'), subject)
  // `errors` is a module of the fixture, but `api` does NOT depend on it: the
  // claim is contradicted by the graph rather than merely misspelled.
  const contradicted = anchor.verify(claim('api -> errors', { targetId: 'errors' }), subject)
  assert.equal(anchored.status, 'anchored')
  assert.equal(anchored.tier, 'recomputed-unique')
  assert.equal(contradicted.status, 'unanchored', 'the graph has no api -> errors edge, so the claim is contradicted')
  assert.equal(contradicted.tier, 'locator-mismatch')

  // The coverage proof that follows from the real verdicts — computed, not typed in.
  const kept = [anchored].filter((verdict) => verdict.status === 'anchored')
  const proof = coverage(happy.expect.admitted, kept)
  assert.equal(proof.total, 8)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.125)
  assert.equal(proof.complete, false)
})

// ---------------------------------------------------------------------------
// The engine boundary: the domain locator must SURVIVE the trip
// ---------------------------------------------------------------------------

console.log('\nthe engine boundary — the domain locator must arrive intact')

await testAsync('the engine hands this domain\'s verifier the caller\'s locator VERBATIM, not a rebuilt one', async () => {
  const ctx = createPluginContext()
  const locator = {
    kind: 'dependency-edge',
    path: 'src/api/handler.ts',
    moduleId: 'api',
    targetId: 'core',
    findingKind: 'edge',
  }

  // ADDED (t20). Everything above this point calls `anchor.verify` directly, and
  // that is not enough: `recomputeAnchor` in `index.js` USED TO rebuild the claim
  // from the engine's generic anchor vocabulary
  // (`{start, startLine, end, endLine}`) and drop `finding.locator` entirely, so
  // a graph-shaped locator never reached this verifier at all. That behaviour is
  // GONE — `index.js:734` ("CHANGED (t17, second pass)") passes the caller's
  // `locator` through VERBATIM and folds `start`/`end` in ONLY when no locator was
  // supplied.
  //
  // `adjudication_anchor` returns the claim the engine actually constructed, so
  // this reads the boundary itself rather than inferring it from a verdict. Under
  // the old engine the deepEqual below would compare against `{}` or
  // `{start, startLine, end, endLine}` and go red. It is the one assertion in
  // this file that would catch a refactor reintroducing locator reconstruction.
  const anchored = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'architecture',
    path: 'src/api/handler.ts',
    excerpt: 'api -> core',
    locator,
    documents: [
      { path: 'src/api/handler.ts', content: '' },
      {
        path: '(the manifest)',
        content: '',
        // A graph-shaped domain carries its graph in the document, which is why
        // `toDocuments` preserves every field instead of keeping `{path, content}`.
        modules: [
          { id: 'api', path: 'src/api/handler.ts', dependsOn: ['core'], layer: 'application' },
          { id: 'core', path: 'src/core/engine.ts', dependsOn: [], layer: 'domain' },
        ],
        adrs: [],
      },
    ],
  }, {})

  assert.equal(anchored.via, 'anchorVerifier', 'the engine must route through the pack anchorVerifier')
  assert.deepEqual(anchored.claim.locator, locator,
    'the locator must arrive byte-for-byte; a rebuilt {start,startLine,end,endLine} would prove the old defect is back')
  assert.equal(anchored.claim.kind, 'module-and-adr')
  assert.equal(anchored.claim.path, 'src/api/handler.ts')
})

await testAsync('a finding carrying this domain\'s locator is anchored THROUGH adjudication_submit and counted in coverage', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'architecture',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  // FLIPPED (t23). This test used to be a GAP probe: it asserted that a submit
  // carrying this domain's locator was routed to the verifier and then REFUSED,
  // because `anchor.js` demanded `subject.modules` while the engine handed over
  // `{ path, content, document, documents }`. It was written to go red the day the
  // gap closed, and it did.
  //
  // What closed it: the graph is rebuilt from the engine's own candidate set
  // (`subject.candidates`), the one piece of P0 structure the engine forwards. The
  // documents below deliberately carry NO `modules`/`adrs`, so an anchor here can
  // only have come from the candidates — the assertion cannot be satisfied by
  // stuffing the payload into a document.
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'architecture',
    target: 'fixture happy-path',
    documents: [{ path: 'src/api/handler.ts', content: 'api -> core' }],
    findings: [{
      id: 'f-located',
      path: 'src/api/handler.ts',
      excerpt: 'api -> core',
      evidence: 'api -> core',
      locator: {
        kind: 'dependency-edge',
        path: 'src/api/handler.ts',
        moduleId: 'api',
        targetId: 'core',
        findingKind: 'edge',
      },
      severity: 'high',
      message: 'api 依赖 core',
      defended: true,
    }],
  }, {})

  assert.equal(submitted.anchorVia, 'anchorVerifier')
  assert.equal(submitted.unanchored, 0, 'a finding whose locator the verifier can recompute must anchor')
  assert.equal(submitted.findings.length, 1)
  const finding = submitted.findings[0]
  assert.equal(finding.anchored, true)
  assert.equal(finding.anchorTier, 'recomputed-unique')
  assert.ok(TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier))
  assert.equal(finding.anchorLocator.moduleId, 'api')
  assert.equal(finding.anchorLocator.targetId, 'core')
  assert.equal(submitted.coverage.reviewed, 1, 'the anchored path must be counted as reviewed')
  assert.equal(submitted.coverage.total, new Set(happy.expect.paths).size, 't51: the denominator is the plan admission measured in the unit coverage() reports (distinct paths, not candidates)')
  assert.equal(submitted.coverage.totalSource, 'plan')
  assert.equal(submitted.criticismKind, 'fact-checker')

  // REFUSAL IS UNCHANGED (this is the other half of the flip, and the reason the
  // one above is worth anything): an edge the rebuilt graph does NOT have is still
  // unanchored, and the detail says which basis refused it. Closing the gap must
  // not turn "cannot verify" into "let it through".
  const contradicted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'architecture',
    target: 'fixture happy-path',
    documents: [{ path: 'src/api/handler.ts', content: 'errors -> api' }],
    findings: [{
      id: 'f-bogus',
      path: 'src/api/handler.ts',
      excerpt: 'errors -> api',
      evidence: 'errors -> api',
      locator: {
        kind: 'dependency-edge',
        path: 'src/api/handler.ts',
        moduleId: 'errors',
        targetId: 'api',
        findingKind: 'edge',
      },
      severity: 'high',
      message: 'errors 依赖 api',
      defended: true,
    }],
  }, {})
  assert.equal(contradicted.unanchored, 1, 'an edge the graph does not contain must stay unanchored')
  assert.equal(contradicted.findings.length, 0)
  assert.equal(contradicted.coverage.reviewed, 0)
  assert.match(contradicted.unanchoredDetails[0].detail, /依赖图里没有这条边/u)
  // And the verdict states WHICH basis it used — a graph rebuilt from the plan is
  // not the same evidence as a graph handed over directly, and the report says so.
  assert.match(contradicted.unanchoredDetails[0].detail, /候选集重建/u)
})

await testAsync('adjudication_activate registers this domain\'s own tool names', async () => {
  const ctx = createPluginContext()
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.ok(listed.domains.some((item) => item.id === 'architecture'), 'architecture must be in the registry')
  const directory = listed.directory
  assert.ok(directory !== null, 'the directory report must be present once directory domains exist')
  assert.ok(directory.loaded.includes('architecture'), `loaded: ${directory.loaded.join(', ')}`)
  assert.deepEqual(directory.problems.filter((entry) => entry.id === 'architecture'), [])

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'architecture' }, {})
  assert.equal(activated.ok, true, activated.summary)
  for (const name of ['adjudicate_architecture', 'adjudicate_architecture_plan', 'adjudicate_architecture_rules']) {
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
