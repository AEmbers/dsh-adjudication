/**
 * project-management — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  deterministic candidate set
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey.resolve          ->  real workstream grouping (not one-per-path)
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  recomputed edges / cycles / orphans
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * Then it drives the assembled pack through the plugin's own mock Cordis context,
 * so the domain is proven to work where it is actually used.
 *
 * FOUR THINGS THIS FILE REFUSES TO DO
 * -----------------------------------
 * 1. It never asserts a status without asserting the tier. "anchored" alone is
 *    satisfiable by a verifier that guesses; the tier is what says it did not.
 * 2. It never lets P4 and P6 share a prompt. `assert.notEqual(p6.system,
 *    p4.system)` is load-bearing: the contract validators do NOT check it, so
 *    without this assertion a domain could pass `validateDomainPackV2` while
 *    handing its reviewer its own reasoning back.
 * 3. It never asserts `bundleKey.applied` alone. The acceptance is that two
 *    candidates which SHOULD share a bundle really do — an `applied: true` with a
 *    per-candidate key would be P2 silently not done.
 * 4. It never feeds the plugin a self-reported anchor. Every coverage assertion
 *    downstream of `adjudication_submit` is driven by findings this file first put
 *    through the domain's own `anchorVerifier.verify`, so the numbers follow from
 *    the graph and not from a number this file made up.
 *
 * Usage: `node domains/project-management/test.mjs`
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ANCHOR_TIERS,
  MIN_RULES_PER_DOMAIN,
  MANDATORY_FIXTURES,
  TRUSTED_ANCHOR_TIERS,
  checkContractIntegrity,
  evidenceToolName,
  inputFormatFor,
  validateAnchorVerdict,
  validateCandidateSetResult,
  validateDomainPackV2,
  validateEvidenceToolkit,
  validateFixture,
  validatePromptOutput,
  validateRuleDocument,
} from '../../lib/contracts.js'
import {
  bundle,
  coverage,
  createBudget,
  gate,
  report,
  resolveAnchor,
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { createNodeIo, loadDomain, loadDomains } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack, { bundleKey as declaredBundleKey, GATE_EXTENSIONS } from './index.js'
import source from './source.js'
import anchor, { ANCHOR_KINDS, REACHABLE_TIERS, constituentsDeclared } from './anchor.js'
import evidence from './evidence.js'
import prompts from './prompts.js'

const here = dirname(fileURLToPath(import.meta.url))
const DOMAIN = 'project-management'
const FORMAT = 'task-graph'

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
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
  FIXTURES.set(fixture.name, fixture)
}

const fixture = (name) => {
  const value = FIXTURES.get(name)
  assert.ok(value !== undefined, `missing fixture "${name}"`)
  return value
}

const RULE_FILES = readdirSync(join(here, 'rules')).filter((file) => file.endsWith('.md')).sort()

const inputPayload = (name) => {
  const value = fixture(name)
  return { input: { format: value.input.format, payload: value.input.payload }, gate: value.gate ?? {} }
}

/** Enumerate + gate one fixture. A fixture may NARROW the pack's gate, never widen it. */
function runP0P1(name) {
  const { input, gate: overrides } = inputPayload(name)
  const context = { maxCandidates: 400, maxExcerptLines: 200 }
  const enumerated = source.enumerate(input.payload, context)
  const result = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: [...(pack.gate?.exclude ?? []), ...(overrides.exclude ?? [])],
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

/** Apply the pack's `bundleKey` the way `index.js` does, then bundle. */
const keyedBundles = (selected) => {
  const infos = selected.map((entry) => declaredBundleKey.resolve(entry))
  const bundled = bundle(selected.map((entry, index) => ({ ...entry, key: infos[index] })))
  return { bundled, infos }
}

/** Every anchor case in a fixture, tagged with its bucket. */
function anchorCases() {
  const cases = []
  for (const [name, value] of FIXTURES) {
    for (const bucket of ['positive', 'negative', 'ambiguous']) {
      for (const entry of value.anchors?.[bucket] ?? []) cases.push({ fixture: name, bucket, entry })
    }
  }
  return cases
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\nproject-management domain — contract v2 end-to-end')
console.log('='.repeat(64))
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
    ruleLibrary: { dir: 'rules', rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['**/*'], text: 'y'.repeat(12), needsExpertReview: true })) },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor(DOMAIN)
  assert.equal(declared.format, FORMAT)
  assert.equal(source.inputFormat, FORMAT)
  assert.equal(pack.candidateSet.inputFormat, FORMAT)
  assert.equal(pack.candidateSet.kind, source.kind)
})

await testAsync('index.js exports NO named candidateSource — a descriptor there would shadow source.js', async () => {
  // The loader prefers a named `candidateSource` export over the sibling file, so a
  // descriptor-shaped named export would win the assembly and then fail validation
  // with "enumerate must be a function". Cheap to check, expensive to debug.
  const namespace = await import('./index.js')
  assert.equal(namespace.candidateSource, undefined, 'index.js must not export candidateSource')
  assert.equal(typeof namespace.default.candidateSet.kind, 'string')
  assert.equal(typeof source.enumerate, 'function')
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable', 'this anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('criticism.kind agrees with the loss orientation', () => {
  assert.equal(pack.lossOrientation, 'precision-first')
  assert.equal(pack.criticism.kind, 'fact-checker')
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

test('every tier the verifier can return is either a contract tier or a documented extension', () => {
  // The contract validates `tier` against its own table, so an extension name must
  // never reach `tier`. `id-ambiguous` is the one extension this domain has, and it
  // is reported through `scope` — this assertion is what keeps that true.
  const declared = new Set(Object.keys(ANCHOR_TIERS))
  for (const tier of REACHABLE_TIERS) {
    assert.ok(declared.has(tier), `"${tier}" is not a tier lib/contracts.js declares — it must not be returned as \`tier\``)
  }
})

// ---------------------------------------------------------------------------
// P0 — the shape of a claim, and the anchor vocabulary overload
// ---------------------------------------------------------------------------

console.log('\nP0/P5 — the anchor vocabulary')

test('the anchor vocabulary overload is deliberate and machine-checkable', () => {
  // `validateAnchorVerdict` requires an anchored verdict to carry a 1-based
  // integer `start`. A graph has no lines, so the span is REUSED with `position`
  // naming what it indexes — see the header of _lib/graph.js. This assertion pins
  // the overload: every anchored verdict must say what its span means.
  const verdict = anchor.verify(
    { kind: anchor.kind, path: 'project/plan.json', declared: true, locator: { kind: 'task-edge', from: 'T2', to: 'T1' } },
    { path: 'project/plan.json', documents: [{ path: 'project/plan.json', payload: { tasks: [{ id: 'T1' }, { id: 'T2', dependsOn: ['T1'] }] } }] },
  )
  assert.equal(verdict.status, 'anchored')
  assert.equal(typeof verdict.position, 'string')
  assert.deepEqual(verdict.nodes, ['T2', 'T1'])
  assert.equal(verdict.start, 1, 'the reused span is an ordinal, not a line number')
  assert.deepEqual(validateAnchorVerdict(verdict), [])
})

test('every claim kind the prompts advertise is one the verifier implements', () => {
  for (const kind of ANCHOR_KINDS) {
    const verdict = anchor.verify(
      { kind: anchor.kind, path: 'project/plan.json', locator: { kind, from: 'A', to: 'B', cycle: ['A'], taskId: 'A', targetId: 'A' } },
      { path: 'project/plan.json', documents: [{ path: 'project/plan.json', payload: { tasks: [{ id: 'A' }] } }] },
    )
    assert.notEqual(verdict.tier, 'kind-mismatch', `locator.kind "${kind}" is advertised but not implemented`)
    assert.deepEqual(validateAnchorVerdict(verdict), [])
  }
})

// ---------------------------------------------------------------------------
// P3 — the rule library
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

test('every rule has a concrete failure mode and a boundary, not a platitude', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const body = text.slice(text.indexOf('\n---', 4))
    assert.ok(body.length > 60, `${file} body is too thin to be a rule`)
    assert.match(body, /不算|不成立|不是|必须给出|取证|排除/u,
      `${file} must state what does NOT count — a rule with no boundary is unenforceable`)
  }
})

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'json-only', match: ['**/*.json'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['project/plan-task-t1.json'])
  assert.deepEqual(selected.injected.map((rule) => rule.name).sort(), ['any', 'json-only'])
  const missed = selectRules([{ name: 'md-only', match: ['**/*.md'], text: 'x'.repeat(20) }], ['project/plan-task-t1.json'])
  assert.deepEqual(missed.injected, [])
  assert.deepEqual(missed.unmapped, ['project/plan-task-t1.json'])
})

test('F1: every extension this pack declares readable is ALSO matchable by at least one rule', () => {
  // The defect this pins, in the captain's own framing: prototype #9 of "the test
  // describes what I thought happens, not what must happen", and the subtlest of
  // them because it lives BETWEEN two individually-correct parts. The gate config
  // was right; the rule files were right; every existing assertion was true; only
  // their INTERSECTION was empty — `.json` plans were reviewed against 26 rules and
  // `.yaml`/`.yml`/`.md`/`.csv` plans against NONE, in silence.
  //
  // Computed from `GATE_EXTENSIONS`, the pack's OWN export, rather than from a
  // copied list: a copy drifts the moment someone adds an extension, and the drift
  // is invisible precisely because it is a copy.
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const match = text.match(/^match:\n((?:  - .+\n)+)/mu)?.[1]
      ?.split('\n').filter(Boolean).map((line) => line.replace(/^  - /u, '').replace(/^"|"$/gu, '')) ?? []
    return { name: text.match(/^name: (.+)$/mu)[1].trim(), match }
  })
  assert.ok(GATE_EXTENSIONS.length > 0, 'the pack must declare at least one readable extension')

  const starved = []
  for (const extension of GATE_EXTENSIONS) {
    const probe = `project/plan-task-t1${extension}`
    const { injected, unmapped } = selectRules(rules, [probe])
    if (injected.length === 0) starved.push(extension)
    assert.deepEqual(unmapped, [], `${extension}: an admitted candidate must be mapped by some rule`)
  }
  assert.deepEqual(starved, [],
    `these declared extensions reach the reviewer with ZERO rules: ${starved.join(', ')} — widen the rule match globs or narrow GATE_EXTENSIONS, but do not leave the intersection empty`)

  // The same defect seen from the rule side: a family that can match NOTHING the
  // gate can ever admit is dead weight pretending to be coverage.
  const admittedProbe = GATE_EXTENSIONS.map((extension) => `project/plan-task-t1${extension}`)
  const dead = rules.filter((rule) => selectRules([rule], admittedProbe).injected.length === 0)
  assert.deepEqual(dead.map((rule) => rule.name), [], 'these rules cannot match any document this pack admits')
})

await testAsync('F1: through the REAL plugin, every declared extension yields bundles that carry rules', async () => {
  // `selectRules` above is the mechanism; this goes through `adjudication_plan`,
  // because the intersection can also break one layer up. "The gate admitted it" is
  // NOT the claim under test — "the reviewer got a checklist" is.
  const ctx = createPluginContext()
  const plan = ctx.__tools.get('adjudication_plan')
  const happy = fixture('happy-path')
  const [document] = happy.input.payload.documents

  // The LOADED pack: the P4 prompt recomputes coverage from the globs the loader
  // assembled, and the plan's `bundle.rules` is a list of NAMES, not rules.
  const io = await createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })
  const loaded = await loadDomain(io, { id: DOMAIN, dir: `domains/${DOMAIN}` })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))

  for (const extension of GATE_EXTENSIONS) {
    const payload = {
      ...happy.input.payload,
      documents: [{ ...document, path: `project/plan${extension}` }],
    }
    const planned = await plan.execute({
      domain: DOMAIN,
      target: `extension ${extension}`,
      input: { format: happy.input.format, payload },
    }, {})

    assert.ok(planned.gate.admitted > 0, `${extension}: declared readable, so the gate must admit it`)
    assert.ok(planned.bundles.length > 0, `${extension}: admitted candidates must form bundles`)
    const covered = planned.bundles.reduce((sum, item) => sum + item.rules.length, 0)
    assert.ok(covered > 0,
      `${extension}: admitted ${planned.gate.admitted} candidates but injected 0 rules — this is the empty intersection`)
    for (const item of planned.bundles) {
      assert.ok(item.rules.length > 0, `${extension}: bundle ${item.key} got no rules`)

      // The domain's OWN prompt, rendered for this real bundle, must be free of the
      // starvation warning. That is the assertion that pins the fix: the kernel's
      // `unmappedPaths` counter is unreliable (see prompts.js), so asserting on it
      // would be asserting on the wrong thing.
      const p4 = prompts.review({
        pack: loaded.pack,
        orientation: loaded.pack.lossOrientation,
        bundle: item,
        ruleText: item.ruleText,
        budget: createBudget(),
      })
      assert.doesNotMatch(p4.system, /没有被任何规则覆盖/u,
        `${extension}: bundle ${item.key} carried rules yet the reviewer was warned of uncovered candidates`)
    }
  }
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  // The extra fixtures this domain ships are the ones its own structure needs.
  assert.ok(FIXTURES.has('cycle-and-orphan'))
  assert.ok(FIXTURES.has('unknown-target'))
  assert.ok(FIXTURES.has('id-collision'))
  assert.ok(FIXTURES.has('relocate-ambiguous'))
})

test('every fixture declares anchors with both positive and negative cases', () => {
  for (const [name, value] of FIXTURES) {
    assert.ok(value.anchors, `${name} must declare anchors`)
    assert.ok(value.anchors.positive?.length > 0, `${name} needs a positive anchor case`)
    assert.ok(value.anchors.negative?.length > 0, `${name} needs a negative anchor case`)
  }
})

test('every fixture is structurally valid, with bundleKeys checked here because the contract has no such field', () => {
  for (const [name, value] of FIXTURES) {
    const { bundleKeys, ...restricted } = value.expect
    const problems = validateFixture({ ...value, expect: restricted }, FORMAT)
    assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`)
    if (bundleKeys !== undefined) {
      assert.ok(Array.isArray(bundleKeys) && bundleKeys.length > 0, `${name}.expect.bundleKeys must be a non-empty array`)
    }
  }
})

// ---------------------------------------------------------------------------
// P0 / P1 — the three boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — empty / all-gated-out / admitted')

test('boundary: an empty task graph produces an EMPTY candidate set, and an empty gate', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  assert.equal(enumerated.candidates.length, fixture('empty').expect.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path), fixture('empty').expect.paths)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
})

test('boundary: all-gated-out enumerates candidates and the gate removes every reviewable one', () => {
  const expected = fixture('all-gated-out').expect
  const { enumerated, result } = runP0P1('all-gated-out')

  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path), expected.paths)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(enumerated.excluded.length, 1, 'the deleted document\'s edge is excluded by the SOURCE, not the gate')
  assert.match(enumerated.excluded[0].reason, /deleted/u)

  const predicates = byPredicate(result)
  for (const [predicate, paths] of Object.entries(expected.excludedByPredicate)) {
    assert.deepEqual(predicates[predicate] ?? [], [...paths].sort(), `predicate "${predicate}" mismatch`)
  }
})

test('boundary: an empty set and a fully-excluded set are distinguishable in the plan', () => {
  const empty = runP0P1('empty')
  const gatedOut = runP0P1('all-gated-out')
  assert.equal(empty.enumerated.candidates.length, 0, 'empty: P0 produced nothing')
  assert.equal(empty.result.excluded.length, 0)
  assert.ok(gatedOut.enumerated.candidates.length > 0, 'all-gated-out: P0 produced something')
  assert.ok(gatedOut.result.excluded.length > 0, 'all-gated-out: P1 removed it')
})

test('boundary: the SOURCE exclusion and the GATE exclusion are two reported paths', () => {
  const { enumerated, result } = runP0P1('all-gated-out')
  // Both are counted, in different fields, with different reasons — a plan that
  // merged them would make "the input declared something unusable" look like
  // "the gate rejected a reviewable candidate".
  assert.ok(enumerated.excluded.length > 0)
  assert.ok(result.excluded.length > 0)
  for (const item of enumerated.excluded) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.reason, 'string')
    assert.ok(!('predicate' in item), 'a source exclusion is not a gate verdict')
  }
  for (const item of result.excluded) assert.equal(typeof item.predicate, 'string')
})

test('happy path: the two-workstream plan is admitted whole and keeps its stream keys', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path), expected.paths)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
})

test('the cycle-and-orphan plan enumerates the cycle edges AND the isolated node', () => {
  const expected = fixture('cycle-and-orphan').expect
  const { enumerated, result } = runP0P1('cycle-and-orphan')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  const paths = result.selected.map((entry) => entry.path)
  // The orphan T9 is in no edge at all. If the source only emitted edges, T9 would
  // be invisible and no finding about it could ever be anchored.
  assert.ok(paths.includes('project/deps-task-t9.json'), 'the isolated node must reach the reviewer as a candidate')
  for (const edge of ['project/deps-t1-t3.json', 'project/deps-t2-t1.json', 'project/deps-t3-t2.json']) {
    assert.ok(paths.includes(edge), `${edge} must be enumerated`)
  }
})

test('the unknown dependency target is enumerated, not silently dropped', () => {
  const { enumerated } = runP0P1('unknown-target')
  const edge = enumerated.candidates.find((candidate) => candidate.meta?.from === 'T1' && candidate.meta?.to === 'T2X')
  assert.ok(edge !== undefined, 'an unregistered dependency target must still produce a candidate')
  assert.equal(edge.meta.unknownTarget, true)
  assert.match(edge.text, /不在本图声明的 ID 空间内/u)
})

test('a cross-document task id collision is reported as a note, and both copies survive', () => {
  const { enumerated } = runP0P1('id-collision')
  const t4 = enumerated.candidates.filter((candidate) => candidate.meta?.taskId === 'T4')
  assert.equal(t4.length, 2, 'both declarations must survive — collapsing them would hide the defect')
  assert.ok(enumerated.notes.some((note) => /任务 ID "T4" 被 2 个文档同时声明/u.test(note)),
    `the collision must be stated, not left for the reviewer to notice: ${JSON.stringify(enumerated.notes)}`)
})

test('candidate ids are unique, paths are gate-globable, and the raw ids stay in the locator', () => {
  for (const [name] of FIXTURES) {
    const { enumerated } = runP0P1(name)
    const ids = enumerated.candidates.map((candidate) => candidate.id)
    assert.equal(new Set(ids).size, ids.length, `${name}: ids must be unique`)
    assert.deepEqual(validateCandidateSetResult(enumerated), [], name)
    for (const candidate of enumerated.candidates) {
      assert.doesNotMatch(candidate.path, /[A-Z>#\s]/u, `${name}: "${candidate.path}" is not gate-globable`)
      assert.match(candidate.path, /\.[a-z0-9]+$/u, `${name}: "${candidate.path}" must end in an extension`)
      assert.equal(typeof candidate.locator.kind, 'string')
    }
  }
})

test('the raw task ids never leak into a path — a slug is lossy and must not be parsed back', () => {
  const { enumerated } = runP0P1('cycle-and-orphan')
  const edge = enumerated.candidates.find((candidate) => candidate.locator.kind === 'dependency-edge')
  assert.equal(edge.locator.from, 'T1')
  assert.equal(edge.locator.to, 'T3')
  assert.doesNotMatch(edge.path, /T1|T3/u, 'the path must not claim to carry the id it cannot represent')
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ tasks: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ documents: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ milestones: 3 }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ risks: 'x' }, {}), /E_INPUT_FORMAT/u)
  // An empty graph is NOT the same as a malformed request: one is "nothing planned".
  assert.doesNotThrow(() => source.enumerate({ tasks: [] }, {}))
  assert.doesNotThrow(() => source.enumerate({ documents: [] }, {}))
})

test('P0 declares bounded:true and the contract agrees for this domain', () => {
  assert.equal(source.bounded, true)
  assert.equal(inputFormatFor(DOMAIN).bounded, true)
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey.resolve
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling by workstream')

test('the v2 bundleKey is an object with a real resolver, and the contract accepts it', () => {
  assert.equal(typeof pack.bundleKey, 'object')
  assert.equal(typeof pack.bundleKey.resolve, 'function')
  // The v1 pack declared the private string 'workstream'; the v2 gate rejects the
  // string form outright, so the resolver is what carries the semantic forward.
  assert.equal(pack.bundleKey.strategy, 'workstream')
  assert.deepEqual(validateDomainPackV2({
    ...pack,
    candidateSource: source,
    anchorVerifier: anchor,
    evidenceTools: evidence,
    reviewPrompts: prompts,
    ruleLibrary: { dir: 'rules', rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['**/*'], text: 'y'.repeat(12), needsExpertReview: true })) },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  }), [])
})

test('two tasks of the SAME workstream land in the SAME bundle — not one bundle per candidate', () => {
  const { result } = runP0P1('happy-path')
  const { bundled, infos } = keyedBundles(result.selected)
  assert.ok(infos.every((info) => typeof info === 'string' && info !== ''), 'every candidate must resolve to a key')

  const cartEntries = result.selected.filter((entry) => entry.meta?.workstream === 'cart')
  assert.ok(cartEntries.length >= 5, `expected a real cart stream, got ${cartEntries.length}`)
  const cartKeys = new Set(cartEntries.map((entry) => declaredBundleKey.resolve(entry)))
  assert.equal(cartKeys.size, 1, `cart tasks must collapse to ONE key, got ${[...cartKeys].join(', ')}`)

  const cartBundle = bundled.bundles.find((item) => item.key === 'ws/cart')
  assert.ok(cartBundle !== undefined, 'the cart bundle must exist by name')
  assert.equal(cartBundle.entries.length, cartEntries.length,
    'the cart bundle must hold exactly the cart candidates — not a subset, not the whole graph')

  // The load-bearing part: bundle size is NOT one. A `{ strategy: 'path' }` cheat
  // would give every candidate its own bundle and still satisfy `applied: true`.
  assert.ok(cartBundle.entries.length > 1, 'a single-entry bundle would mean P2 did nothing')
  assert.ok(bundled.bundles.length > 1, 'a multi-stream plan must split into more than one bundle')
  assert.equal(bundled.strategy, 'keyed')
})

test('the resolved bundle keys are the fixture\'s declared keys, not asserted from a constant', () => {
  const expected = fixture('happy-path').expect.bundleKeys
  const { result } = runP0P1('happy-path')
  const { bundled } = keyedBundles(result.selected)
  assert.deepEqual([...new Set(bundled.bundles.map((item) => item.key))].sort(), expected)
})

test('a candidate with no workstream falls back deterministically to its document', () => {
  const key = declaredBundleKey.resolve({ path: 'project/plan-risk-r1.json', meta: { graphPath: 'project/plan.json' } })
  assert.equal(key, 'doc/project/plan.json')
  assert.equal(declaredBundleKey.resolve({ path: 'a/b/c.json', meta: {} }), 'dir/a/b')
})

test('a bare candidate with no metadata still gets a non-degenerate key', () => {
  const { bundled } = keyedBundles([{ path: 'src/x.ts' }, { path: 'src/y.ts' }, { path: 'src/z.ts' }, { path: 'lib/w.ts' }])
  const src = bundled.bundles.find((item) => item.key === 'dir/src')
  assert.ok(src !== undefined, `expected a directory fallback bundle, got ${bundled.bundles.map((item) => item.key).join(', ')}`)
  assert.equal(src.entries.length, 3)
})

// ---------------------------------------------------------------------------
// P5 — the anchor verifier, positive and negative
// ---------------------------------------------------------------------------

console.log('\nP5 — anchors (the hard constraint)')

function verifyFromCase(entry) {
  const verdict = anchor.verify(entry.claim, normalizeSubject(entry.subject))
  const problems = validateAnchorVerdict(verdict)
  assert.deepEqual(problems, [], `${entry.note}: ${problems.join('; ')}`)
  return verdict
}

/**
 * Unwrap a fixture's graph documents into the shape the verifier reads.
 *
 * A fixture's `input.payload.documents[i]` is a DOCUMENT ENVELOPE
 * (`{ path, type, meta, payload }`) because that is what the P0 source consumes —
 * it needs `meta.bytes`/`meta.deleted` for the gate. The verifier reads the
 * payload directly. Normalising here keeps both shapes honest instead of making
 * one of them lie about what it holds.
 */
function normalizeSubject(subject) {
  if (!Array.isArray(subject?.documents)) return subject
  return {
    ...subject,
    documents: subject.documents.map((document) =>
      (document?.payload !== null && typeof document?.payload === 'object' && 'path' in document
        ? { path: document.path, type: document.type, payload: document.payload }
        : document)),
  }
}

for (const { fixture: name, entry } of anchorCases()) {
  test(`anchor ${entry.expectTier} [${name}]`, () => {
    const verdict = verifyFromCase(entry)
    assert.equal(verdict.status, entry.expectStatus, entry.note)
    assert.equal(verdict.tier, entry.expectTier, entry.note)
    if (verdict.status === 'anchored') {
      assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier), `tier "${verdict.tier}" is not trusted`)
      assert.equal(typeof verdict.position, 'string', 'an anchored graph verdict must name what its span indexes')
      if (entry.expectPath !== undefined) assert.equal(verdict.path, entry.expectPath)
    } else {
      assert.equal(verdict.start, null, 'an unanchored verdict must not carry a span')
      assert.equal(verdict.path, null)
      assert.equal(typeof verdict.detail, 'string', 'every unanchored verdict must explain itself')
    }
  })
}

for (const { fixture: name, entry } of anchorCases().filter((item) => item.bucket === 'ambiguous')) {
  test(`anchor ambiguity lists its competitors [${name}]`, () => {
    const verdict = verifyFromCase(entry)
    assert.equal(verdict.status, 'unanchored')
    assert.equal(verdict.tier, 'relocation-ambiguous')
    assert.ok(Array.isArray(verdict.ambiguousIn) && verdict.ambiguousIn.length > 1,
      'an ambiguous verdict must list the competing locations')
    if (entry.expectAmbiguousIn !== undefined) {
      // Set equality, not array equality: the competitors are a SET, and the order
      // a path enumerator happens to produce is not part of the finding. Asserting
      // the exact order would make this test fail on a harmless reordering.
      assert.deepEqual([...verdict.ambiguousIn].sort(), [...entry.expectAmbiguousIn].sort())
    }
  })
}

test('a paraphrase never anchors, even when the intent is obvious', () => {
  const documents = [{ path: 'project/plan.json', payload: { tasks: [{ id: 'T2' }, { id: 'T4', dependsOn: ['T2'] }] } }]
  const verdict = anchor.verify(
    { kind: anchor.kind, path: 'project/plan.json', locator: { kind: 'task-edge', from: 'T4', to: 'T2', note: 'T4 在等 T2 的工作' } },
    { path: 'project/plan.json', documents },
  )
  // The note is ignored: the claim is the ID pair, and the pair is real. Prose adds
  // nothing to it and can never rescue a pair that is not.
  assert.equal(verdict.status, 'anchored')

  const proseOnly = anchor.verify(
    { kind: anchor.kind, path: 'project/plan.json', locator: { kind: 'task-edge', note: 'T4 在等 T2 的工作' } },
    { path: 'project/plan.json', documents },
  )
  assert.equal(proseOnly.status, 'unanchored')
  assert.equal(proseOnly.tier, 'empty-excerpt')
})

test('a reversed edge is refused rather than repaired', () => {
  const documents = [{ path: 'project/plan.json', payload: { tasks: [{ id: 'T1' }, { id: 'T2', dependsOn: ['T1'] }] } }]
  const reversed = anchor.verify(
    { kind: anchor.kind, path: 'project/plan.json', locator: { kind: 'task-edge', from: 'T1', to: 'T2' } },
    { path: 'project/plan.json', documents },
  )
  assert.equal(reversed.status, 'unanchored')
  assert.equal(reversed.tier, 'locator-mismatch')
  assert.match(reversed.detail, /反向边/u)
})

test('an unclosed cycle is refused rather than completed', () => {
  const documents = [{ path: 'project/open.json', payload: { tasks: [{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['C'] }, { id: 'C' }] } }]
  const verdict = anchor.verify(
    { kind: anchor.kind, path: 'project/open.json', locator: { kind: 'cycle-path', cycle: ['A', 'B', 'C'] } },
    { path: 'project/open.json', documents },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /环未闭合/u)
})

test('a cross-graph relocation must be unique', () => {
  const shared = { tasks: [{ id: 'T1' }, { id: 'T2', dependsOn: ['T1'] }] }
  const claim = { kind: anchor.kind, path: 'project/missing.json', locator: { kind: 'task-edge', from: 'T2', to: 'T1' } }

  const ambiguous = anchor.verify(claim, {
    path: 'project/missing.json',
    documents: [
      { path: 'project/a.json', payload: shared },
      { path: 'project/b.json', payload: shared },
    ],
  })
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['project/a.json#task-edge', 'project/b.json#task-edge'])

  const unique = anchor.verify(claim, {
    path: 'project/missing.json',
    documents: [
      { path: 'project/a.json', payload: shared },
      { path: 'project/b.json', payload: { tasks: [{ id: 'T9' }] } },
    ],
  })
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
  assert.equal(unique.path, 'project/a.json')
})

test('the tier records HOW the claim was confirmed — declared ids vs a re-derived reading', () => {
  // The regularity, not the current state: the tier must follow the JUDGEMENT, so
  // both tiers have to be reachable and they have to mean different things.
  //
  //   locator carries the constituent ids  -> the caller said which relationship it
  //                                           means and the graph confirmed it
  //                                           -> declared-locator
  //   locator carries only an excerpt      -> the verifier had to work out which
  //                                           relationship is meant, uniquely
  //                                           -> recomputed-unique
  //   ... and if the excerpt fits two       -> recomputation is not unique, so the
  //                                           claim is refused, never narrowed
  const documents = [{
    path: 'project/tier.json',
    payload: { tasks: [{ id: 'T1', dependsOn: ['T3'] }, { id: 'T3', dependsOn: ['T2'] }, { id: 'T2' }] },
  }]
  const subject = { path: 'project/tier.json', documents }

  const declared = anchor.verify(
    { kind: 'task-and-edge', path: 'project/tier.json', locator: { kind: 'task-edge', from: 'T1', to: 'T3' } },
    subject,
  )
  assert.equal(declared.status, 'anchored')
  assert.equal(declared.tier, 'declared-locator')
  assert.equal(constituentsDeclared('task-edge', { from: 'T1', to: 'T3' }), true)
  assert.equal(constituentsDeclared('task-edge', { kind: 'task-edge' }), false)

  const derived = anchor.verify(
    {
      kind: 'task-and-edge',
      path: 'project/tier.json',
      locator: { kind: 'task-edge' },
      excerpt: 'T1 依赖 T3 —— 摘录只完整提到这一条边。',
    },
    subject,
  )
  assert.equal(derived.status, 'anchored')
  assert.equal(derived.tier, 'recomputed-unique')
  assert.deepEqual(derived.nodes, ['T1', 'T3'])

  // The whole cycle written out in prose mentions three ids and therefore fits TWO
  // edges. Quoting a graph in a sentence does not anchor it.
  const prose = anchor.verify(
    {
      kind: 'task-and-edge',
      path: 'project/tier.json',
      locator: { kind: 'task-edge' },
      excerpt: 'T1 依赖 T3，T3 又依赖 T2。',
    },
    subject,
  )
  assert.equal(prose.status, 'unanchored')
  assert.equal(prose.tier, 'relocation-ambiguous')
  assert.equal(prose.ambiguousIn.length, 2)

  // An id boundary matters: `T1` must not be matched inside `T12`.
  const longer = [{ path: 'project/tier.json', payload: { tasks: [{ id: 'T12', dependsOn: ['T3'] }] } }]
  const boundary = anchor.verify(
    { kind: 'task-and-edge', path: 'project/tier.json', locator: { kind: 'task-edge' }, excerpt: 'T12 依赖 T3' },
    { path: 'project/tier.json', documents: longer },
  )
  assert.equal(boundary.status, 'anchored')
  assert.deepEqual(boundary.nodes, ['T12', 'T3'])
})

test('the all-gated-out fixture is excluded by the PACK\'s own gate, not by a fixture-local rule', () => {
  // The failure this guards against: a fixture that reaches `admitted: 0` only because it
  // smuggled extra `exclude` globs into itself. Such a fixture passes its own test and then,
  // driven through the plugin (which uses the PACK's gate), admits everything — a test that
  // proves nothing about the pack.
  //
  // The pack's own gate here is deliberately SHORT (`node_modules`, `.git`, `archived` plus
  // five extensions), because `DEFAULT_EXCLUDE_PATTERNS` in `lib/engine.js` already covers
  // the build directories as `default-path`. The assertion is that the combination really
  // does exclude all six candidates, with each exclusion attributable to one of the four
  // predicates — never to the fixture.
  for (const [name, value] of FIXTURES) {
    assert.equal(value.gate, undefined, `${name} must not carry its own gate rules`)
  }
  const gated = fixture('all-gated-out')
  const { result } = runP0P1('all-gated-out')
  assert.equal(result.selected.length, 0, 'the pack\'s own gate admits nothing')
  assert.equal(result.excluded.length, gated.expect.candidates)
  assert.deepEqual(Object.keys(byPredicate(result)).sort(), ['binary', 'deleted', 'extension', 'user-exclude'])
})

test('every claim kind is exercised in BOTH directions — a kind that can only confirm is unfalsifiable', () => {
  // A verifier that can sometimes say "yes" is half a verifier. For each kind this file
  // requires at least one fixture case that CONFIRMS it and at least one that REFUTES it,
  // so no kind can be satisfied by returning `declared-locator` unconditionally.
  //
  // The cases are located BY KIND rather than listed here, so adding a kind without
  // covering it fails this assertion instead of passing silently.
  const every = anchorCases()
  for (const kind of ANCHOR_KINDS) {
    const forKind = every.filter(({ entry }) => entry.claim?.locator?.kind === kind)
    assert.ok(forKind.length > 0, `no fixture exercises the claim kind "${kind}"`)
    const confirmable = forKind.filter(({ entry }) => entry.expectStatus === 'anchored')
    const refutable = forKind.filter(({ entry }) => entry.expectStatus === 'unanchored')
    assert.ok(confirmable.length > 0, `"${kind}" has no confirming case — it can never be satisfied`)
    assert.ok(refutable.length > 0, `"${kind}" has no refuting case — it is unfalsifiable`)
    for (const { entry } of [...confirmable, ...refutable]) {
      const verdict = anchor.verify(entry.claim, normalizeSubject(entry.subject))
      assert.equal(verdict.status, entry.expectStatus, `${kind}: ${entry.note}`)
      assert.equal(verdict.tier, entry.expectTier, `${kind}: ${entry.note}`)
    }
  }
})

test('the tier comes from the caller\'s locator, never from a flag on the claim', () => {
  // The captain's ruling, asserted rather than described: `declared-locator` means the
  // locator the CALLER supplied was independently confirmed — the same judgement the nine
  // already-migrated domains make when they check `locator.startLine` and then verify it.
  //
  // This file used to read a `claim.declared` bit that NOTHING ever set, which silently
  // demoted every confirmed claim to `recomputed-unique` — a tier whose contract meaning
  // is "the locator was missing or wrong and the verifier had to re-derive the position".
  // That was false here, and the bit was the only place in the whole package that read it.
  //
  // The two assertions below pin the rule from both sides: a flag cannot promote an
  // incomplete locator, and a complete locator needs no flag.
  const subject = {
    path: 'project/tier.json',
    documents: [{ path: 'project/tier.json', payload: { tasks: [{ id: 'T1', dependsOn: ['T3'] }, { id: 'T3', dependsOn: ['T2'] }, { id: 'T2', dependsOn: ['T1'] }, { id: 'T9' }] } }],
  }

  const flaggedButEmpty = anchor.verify(
    { kind: 'task-and-edge', path: 'project/tier.json', declared: true, locator: { kind: 'orphan-task' }, excerpt: 'T9 没有上下游' },
    subject,
  )
  assert.equal(flaggedButEmpty.status, 'anchored')
  assert.equal(flaggedButEmpty.tier, 'recomputed-unique', 'a flag must not promote an incomplete locator')

  const unflaggedButComplete = anchor.verify(
    { kind: 'task-and-edge', path: 'project/tier.json', locator: { kind: 'orphan-task', taskId: 'T9' } },
    subject,
  )
  assert.equal(unflaggedButComplete.status, 'anchored')
  assert.equal(unflaggedButComplete.tier, 'declared-locator', 'a complete locator needs no flag')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const documents = [{ path: 'project/plan.json', payload: { tasks: [{ id: 'T1' }] } }]
  const verdict = anchor.verify(
    { kind: 'id-chain', path: 'project/plan.json', locator: { kind: 'task-edge', from: 'T1', to: 'T1' } },
    { path: 'project/plan.json', documents },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
})

test('the engine\'s own anchor path and this verifier agree on the fixtures', () => {
  // `adjudication_anchor` currently routes through the engine's generic text
  // resolver, which cannot see a graph. What this asserts is the CONVERSE for the
  // cases this domain owns: where the generic resolver can speak (a task body is
  // text), the domain verifier and the engine resolver do not contradict each
  // other. The graph itself is verified by `anchor.verify` above.
  const documents = [{ path: 'project/plan.json', content: 'task T7（搜索索引重建）\n负责人：carol\n估算：6 天' }]
  const engineVerdict = resolveAnchor('负责人：carol', documents, 'project/plan.json')
  assert.equal(engineVerdict.status, 'anchored')
  assert.equal(engineVerdict.start, 2)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['project/plan-task-t1.json'],
  bundle: { key: 'ws/cart', paths: ['project/plan-task-t1.json'], rules: ['single-owner'] },
  ruleText: '<rules path="project/plan-task-t1.json">\n责任唯一：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 200, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [{
    id: 'f1',
    path: 'project/plan.json',
    claim: 'task-edge',
    nodes: ['T2', 'T1'],
    evidence: 'depends-on T2 → T1',
    message: 'T2 等待 T1，而 T1 属于另一个未确认的团队',
    defended: true,
  }],
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

test('F1: an admitted-but-unruled candidate is a LOUD warning in P4 — and never in P6', () => {
  // The second half of F1. Widening the rule globs makes the intersection non-empty
  // for the extensions this pack declares; this is what keeps it that way for
  // everything ELSE, and what turns "the substrate is starved" from a silent empty
  // rule set into a sentence the reviewer has to answer for.
  const governed = prompts.review({
    pack,
    orientation: pack.lossOrientation,
    bundle: { paths: ['project/plan-task-t1.json'], rules: ['orphan-task'], unmappedPaths: [] },
    budget: createBudget(),
  })
  assert.doesNotMatch(governed.system, /没有被任何规则覆盖/u, 'nothing to warn about when every path matched a rule')

  const starved = prompts.review({
    pack,
    orientation: pack.lossOrientation,
    bundle: { paths: ['project/notes.csv'], rules: [], unmappedPaths: ['project/notes.csv'] },
    budget: createBudget(),
  })
  assert.match(starved.system, /没有被任何规则覆盖/u)
  assert.match(starved.system, /project\/notes\.csv/u, 'the warning must NAME the paths, not hand back a count')
  assert.match(starved.system, /已知盲区/u)
  assert.match(starved.system, /配置缺陷/u, 'an extension the pack never declared readable is a config defect, and must be named as one')
  assert.match(starved.system, /本轮无规则覆盖/u, 'the reviewer must write down that it had no rule, not treat the item as passed')
  assert.notEqual(starved.system, governed.system)

  // Read from the top level as well: a caller reshaping the context must not be able
  // to silently re-disable the warning this test exists to protect.
  const topLevel = prompts.review({
    pack,
    orientation: pack.lossOrientation,
    bundle: { paths: [] },
    unmappedPaths: ['project/other.json'],
    budget: createBudget(),
  })
  assert.match(topLevel.system, /没有被任何规则覆盖/u)
  assert.match(topLevel.system, /project\/other\.json/u)

  // The kernel's own `unmappedPaths` is NOT trusted when the real globs are in hand:
  // `lib/engine.js:selectRules` removes only the FIRST matching path per injected
  // rule, so its `unmapped` list is non-empty for almost any multi-path bundle even
  // when everything matched. Warning on it directly would be a permanent false alarm.
  const withGlobs = {
    ...pack,
    ruleLibrary: { dir: 'rules', rules: [{ name: 'r', match: ['**/*.json'], text: 'x'.repeat(20) }] },
  }
  const covered = prompts.review({
    pack: withGlobs,
    orientation: pack.lossOrientation,
    bundle: {
      paths: ['project/plan-task-t1.json', 'project/plan-task-t2.json'],
      rules: ['r'],
      // The kernel would hand back a non-empty list here. It must not raise a warning.
      unmappedPaths: ['project/plan-task-t2.json'],
    },
    budget: createBudget(),
  })
  assert.doesNotMatch(covered.system, /没有被任何规则覆盖/u,
    'a bundle where every path matched a rule must not warn, however the kernel counted it')

  // ...and when the globs say a path really is uncovered, that DOES warn.
  const genuinelyStarved = prompts.review({
    pack: withGlobs,
    orientation: pack.lossOrientation,
    bundle: { paths: ['project/plan-task-t1.json', 'project/notes.csv'], rules: ['r'], unmappedPaths: [] },
    budget: createBudget(),
  })
  assert.match(genuinelyStarved.system, /没有被任何规则覆盖/u)
  assert.match(genuinelyStarved.system, /project\/notes\.csv/u)
  assert.doesNotMatch(genuinelyStarved.system, /- project\/plan-task-t1\.json/u, 'only the uncovered path is named')

  // P6 does not get it. Its independence rests on not receiving the rule set, and
  // "which documents had no rule" is a statement about how the review was
  // CONFIGURED — showing it to the re-checker invites it to audit the review instead
  // of the graph, which is precisely what P6 exists to prevent.
  const p6 = prompts.verify({
    pack,
    orientation: pack.lossOrientation,
    findings: [],
    bundle: { unmappedPaths: ['project/notes.csv'] },
  })
  assert.doesNotMatch(p6.system, /没有被任何规则覆盖/u)
})

test('P6 cannot see the P4 reasoning: it is handed findings, not the review transcript', () => {
  assert.ok(!Object.hasOwn(verifyContext, 'ruleText'), 'P6 must not receive rule text')
  assert.doesNotMatch(P6.system, /本轮负责的文档/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /责任唯一/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /200/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /责任唯一/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts state the graph anchor law: ids and claim kinds, never prose', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /claim kind|locator\.kind|声称的关系/u)
  }
  assert.match(P4.system, /逐字抄写/u)
  assert.match(P4.system, /不要写「存在依赖问题」/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
})

test('every orientation gets its own loss sentence, so the pack cannot be silently flipped', () => {
  const recall = prompts.review({ ...reviewContext, orientation: 'recall-first' })
  assert.notEqual(recall.system, P4.system)
  assert.match(recall.system, /recall-first/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const CORPUS = [{
  path: 'project/plan.json',
  payload: {
    tasks: [
      { id: 'T1', title: '建模', owner: 'alice', estimateDays: 2, status: 'done' },
      { id: 'T2', title: '合并', owner: 'alice', estimateDays: 3, status: 'doing', dependsOn: ['T1'] },
      { id: 'T3', title: '对接', owner: 'bob', estimateDays: 2, status: 'todo', dependsOn: ['T2'] },
      { id: 'T9', title: '孤立的清理任务', owner: 'carol', estimateDays: 1, status: 'todo' },
    ],
    risks: [{ id: 'R1', trigger: '接口延期', impact: '阻塞 T3', mitigation: '提前索取契约' }],
  },
}]

const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('graph_edges lists the declared edges and reports what it scanned', async () => {
  const tool = toolByName('graph_edges')
  const result = await tool.execute({ corpus: CORPUS }, {})
  assert.deepEqual(result.items.map((item) => `${item.from}->${item.to}`), ['T2->T1', 'T3->T2'])
  assert.equal(result.truncated, false)
  assert.match(result.provenance, /1 张图/u)
})

await testAsync('graph_edges caps its item count and says so', async () => {
  const tool = toolByName('graph_edges')
  const many = {
    path: 'project/big.json',
    payload: { tasks: Array.from({ length: 300 }, (_, index) => ({ id: `N${index}`, dependsOn: ['N0'] })) },
  }
  const result = await tool.execute({ corpus: [many] }, {})
  assert.ok(result.items.length <= tool.limits.maxItems, `${result.items.length} > ${tool.limits.maxItems}`)
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
  assert.ok(result.notes.some((note) => /截断/u.test(note)))
})

await testAsync('task_neighbours answers in both directions and reports orphans', async () => {
  const tool = toolByName('task_neighbours')
  const t2 = await tool.execute({ taskId: 'T2', corpus: CORPUS }, {})
  assert.deepEqual(t2.items[0].dependsOn, ['T1'])
  assert.deepEqual(t2.items[0].dependents, ['T3'])
  assert.equal(t2.items[0].orphan, false)

  const t9 = await tool.execute({ taskId: 'T9', corpus: CORPUS }, {})
  assert.equal(t9.items[0].orphan, true)
  assert.deepEqual(t9.items[0].dependsOn, [])
  assert.deepEqual(t9.items[0].dependents, [])
})

await testAsync('task_neighbours refuses an id the corpus does not know, and explains why that matters', async () => {
  const tool = toolByName('task_neighbours')
  assert.throws(() => tool.execute({ taskId: 'GHOST', corpus: CORPUS }, {}), /没有任务 "GHOST"/u)
})

await testAsync('task_record returns the registered fields, and truncates a long body', async () => {
  const tool = toolByName('task_record')
  const result = await tool.execute({ taskId: 'T2', corpus: CORPUS }, {})
  assert.equal(result.items[0].owner, 'alice')
  assert.equal(result.items[0].estimateDays, 3)
  assert.deepEqual(result.items[0].dependsOn, ['T1'])

  const long = {
    path: 'project/long.json',
    payload: { tasks: [{ id: 'L1', body: Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行`).join('\n') }] },
  }
  const clipped = await tool.execute({ taskId: 'L1', corpus: [long] }, {})
  assert.equal(clipped.truncated, true)
  assert.equal(clipped.items[0].body.split(/\r?\n/u).length, 60)
})

await testAsync('cycle_paths finds the route, and reports when it hit a bound', async () => {
  const tool = toolByName('cycle_paths')
  const cyclic = {
    path: 'project/cycle.json',
    payload: { tasks: [{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['C'] }, { id: 'C', dependsOn: ['A'] }] },
  }
  const found = await tool.execute({ from: 'A', to: 'A', corpus: [cyclic] }, {})
  assert.deepEqual(found.items.map((item) => item.route), [['A', 'B', 'C', 'A']])
  // One route through one node does NOT set the flag: the search explored every
  // edge it had, so "no other cycle" is a supported conclusion here.
  assert.equal(found.truncated, false, 'a graph with exactly one cycle must not claim truncation')

  // Two distinct cycles through the same node, capped at one: now a route really
  // was dropped, and the flag must say so.
  const twoCycles = {
    path: 'project/ambiguous.json',
    payload: {
      tasks: [
        { id: 'A', dependsOn: ['B'] },
        { id: 'B', dependsOn: ['C', 'D'] },
        { id: 'C', dependsOn: ['A'] },
        { id: 'D', dependsOn: ['C'] },
      ],
    },
  }
  const bounded = await tool.execute({ from: 'A', to: 'A', maxPaths: 1, corpus: [twoCycles] }, {})
  assert.equal(bounded.items.length, 1)
  assert.equal(bounded.truncated, true, 'a dropped second route must raise the flag')
  assert.ok(bounded.notes.some((note) => /不构成.*无环的证据/u.test(note)), JSON.stringify(bounded.notes))
})

await testAsync('risk_entries marks the entries whose mitigation is not a real action', async () => {
  const tool = toolByName('risk_entries')
  const corpus = [{
    path: 'project/risks.json',
    payload: {
      risks: [
        { id: 'R1', trigger: '接口延期', impact: '阻塞 T3', mitigation: '提前索取契约' },
        { id: 'R2', trigger: '进度紧张', impact: '上线延后', mitigation: '持续跟进' },
        { id: 'R3', trigger: '预算超支', impact: '缩减范围' },
      ],
    },
  }]
  const result = await tool.execute({ corpus }, {})
  assert.deepEqual(result.items.map((item) => item.riskId), ['R1', 'R2', 'R3'])
  assert.equal(result.items[0].mitigationMissing, false)
  // "持续跟进" is prose that reads like a mitigation but names no action; the tool
  // does NOT judge that — it reports the text so the reviewer must.
  assert.equal(result.items[1].mitigationMissing, false)
  assert.equal(result.items[2].mitigationMissing, true)
})

await testAsync('a request naming an absent graph fails loudly with the available paths', async () => {
  const tool = toolByName('graph_edges')
  assert.throws(() => tool.execute({ path: 'project/nope.json', corpus: CORPUS }, {}), /语料里没有任务图/u)
})

await testAsync('a request with no corpus at all is refused, not answered with "nothing found"', async () => {
  const tool = toolByName('graph_edges')
  assert.throws(() => tool.execute({}, {}), /缺少 `corpus`/u)
})

await testAsync('every tool result satisfies the contract\'s result validator', async () => {
  const { validateEvidenceResult } = await import('../../lib/contracts.js')
  for (const tool of evidence.tools) {
    const args = tool.name === 'task_neighbours' || tool.name === 'task_record'
      ? { taskId: 'T2', corpus: CORPUS }
      : (tool.name === 'cycle_paths' ? { from: 'T2', to: 'T1', corpus: CORPUS } : { corpus: CORPUS })
    const result = await tool.execute(args, {})
    assert.deepEqual(validateEvidenceResult(result, tool.limits), [], `${tool.name}: ${JSON.stringify(result).slice(0, 120)}`)
  }
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName(DOMAIN, 'graph_edges'), 'adjudicate_project_management_evidence_graph_edges')
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
                path: 'project/plan.json',
                claim: 'cycle-path',
                nodes: ['T1', 'T2', 'T3'],
                evidence: 'depends-on T1 → T3 / T2 → T1 / T3 → T2',
                message: '三个任务互相阻塞',
                severity: 'critical',
                defended: true,
              }],
            },
          }),
          dispose: async () => {},
        }
      },
    },
  }, { maxRounds: 4, maxFindings: 20 })

  const { result } = runP0P1('happy-path')
  const { bundled } = keyedBundles(result.selected)
  const budget = createBudget({ maxToolCalls: 50 })
  const outcome = await reasoner.run({
    pack: { ...pack, reviewPrompts: prompts },
    target: 'fixture happy-path',
    bundles: bundled.bundles,
    budget,
    getBudget: () => budget,
    onCharge: () => {},
  })

  assert.equal(outcome.mode, 'subagents')
  assert.equal(outcome.rounds, bundled.bundles.length, 'one bounded pass per bundle')
  assert.equal(outcome.findings.length, bundled.bundles.length)
  assert.ok(requests.length >= 1, 'the reasoner must actually call the child')
  assert.match(requests[0].prompt[0].text, /项目管理/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /锚点是 ID 对/u, 'the anchor law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(5, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 5)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, 0.4)
  assert.equal(proof.complete, false)
})

test('precision-first drops what it cannot prove and keeps what it can', () => {
  const panel = runCritiquePanel([
    { id: 'proven', path: 'project/plan.json', start: 1, severity: 'high', evidence: 'depends-on T1 → T3', defended: true },
    { id: 'bare', path: 'project/plan.json', start: 2, severity: 'low', evidence: '' },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['proven'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['bare'])
  assert.equal(panel.kind, 'fact-checker')
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  const findings = [
    { id: 'a1', path: 'project/plan-task-t1.json', start: 1, severity: 'high', evidence: 'x', defended: true },
    { id: 'a2', path: 'project/plan-task-t2.json', severity: 'high', evidence: 'y', defended: true },
  ]
  const anchored = findings.filter((finding) => typeof finding.start === 'number' && finding.start > 0)
  assert.equal(anchored.length, 1)
  const proof = coverage(2, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.5, 'the unanchored path must not be counted as reviewed')
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 'project/plan.json', start: 1, severity: 'high', evidence: 'x', defended: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 4, excluded: 0, bundles: 2 },
    findings: panel.kept,
    coverageProof: coverage(4, panel.kept),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, DOMAIN)
  assert.equal(built.lossOrientation, 'precision-first')
  assert.equal(built.criticismKind, 'fact-checker')
  assert.equal(built.coverage.coverageRate, 0.25)
  assert.equal(built.generatedAt, null, 'a deterministic engine must not stamp wall-clock time')
})

// ---------------------------------------------------------------------------
// The domain as loaded from disk
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: DOMAIN, dir: `domains/${DOMAIN}` })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'task-graph-edges')
  assert.equal(assembled.anchorVerifier.kind, 'task-and-edge')
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
  const result = await loadDomains(io, { root: 'domains' })
  // Other domain owners are migrating their directories concurrently, so this file
  // must NOT assert "nothing else is skipped" — a sibling's half-finished directory
  // is their business and would make this test flaky for reasons it cannot fix.
  // What it asserts is the part this domain owns: it appears in `packs`, and it is
  // NOT in `problems` or `skipped` under its own id.
  assert.ok(result.packs.some((item) => item.id === DOMAIN), `expected ${DOMAIN} among ${result.packs.map((item) => item.id).join(', ')}`)
  assert.deepEqual(result.problems.filter((item) => item.id === DOMAIN), [], JSON.stringify(result.problems.filter((item) => item.id === DOMAIN)))
  assert.deepEqual(result.skipped.filter((item) => item.id === DOMAIN), [], JSON.stringify(result.skipped.filter((item) => item.id === DOMAIN)))
  const loaded = result.loaded.find((item) => item.id === DOMAIN)
  assert.ok(loaded !== undefined, 'the loader must report what it loaded for this domain')
  assert.ok(loaded.files.includes('source.js') && loaded.files.includes('anchor.js'))
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
      if (typeof callback === 'function' && callback.constructor?.name === 'GeneratorFunction') {
        const iterator = callback()
        const produced = []
        let step = iterator.next()
        while (step.done !== true) {
          if (typeof step.value === 'function') produced.push(step.value)
          step = iterator.next()
        }
        entry.dispose = () => { for (const disposer of produced) disposer() }
      } else if (typeof callback === 'function') {
        const disposer = callback()
        if (typeof disposer === 'function') entry.dispose = disposer
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

await testAsync('adjudication_plan consumes the fixture graph through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'task-graph-edges')
  assert.equal(plan.candidateSet.inputFormat, FORMAT)
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.strategy, 'workstream')
  assert.ok(plan.bundles.length > 1, 'a two-workstream plan must not collapse into one bundle')
  assert.equal(plan.criticism.kind, 'fact-checker')
  assert.match(plan.summary, /复核者：fact-checker/u)
  // The load-bearing bundling assertion, through the plugin this time: the cart
  // workstream must be ONE bundle holding more than one candidate.
  const cart = plan.bundles.find((item) => item.key === 'ws/cart')
  assert.ok(cart !== undefined, `expected a ws/cart bundle, got ${plan.bundles.map((item) => item.key).join(', ')}`)
  assert.ok(cart.paths.length > 1, 'one candidate per bundle would mean P2 did nothing')
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
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
    domain: DOMAIN,
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'project/legacy-plan-task-x1.json': 'deleted',
    'project/legacy-plan-task-x2.json': 'deleted',
    'project/attachments/board-media-task-b1.json': 'binary',
    'node_modules/pm-tool/export-task-z1.json': 'user-exclude',
    'archived/2025-plan-task-a1.json': 'user-exclude',
    'project/notes/untracked-task-n1.txt': 'extension',
  })
  // FOUR different predicates each fire, and the candidate for the `.txt` document
  // keeps `.txt`: a graph domain that re-typed an unsupported document into a
  // supported one would sail through the gate it was supposed to fail.
  assert.equal(plan.gate.admitted, 0)
  assert.match(plan.summary, /准入 0 项/u)
  assert.match(plan.summary, /排除 6 项/u)
})

await testAsync('P0 -> P7 round trip: the domain verifier anchors the cycle and the orphan over the real fixture', async () => {
  const ctx = createPluginContext()
  const cyclic = fixture('cycle-and-orphan')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture cycle-and-orphan',
    input: { format: cyclic.input.format, payload: cyclic.input.payload },
  }, {})

  const documents = cyclic.input.payload.documents
  const subject = { path: 'project/deps.json', documents }

  // A finding that names a real cycle, and one that names a cycle that is not
  // there. Both go through the domain's own verifier FIRST; only the anchored one
  // is allowed to become a finding. Nothing here is a self-reported anchor.
  const claimOk = { kind: anchor.kind, path: 'project/deps.json', declared: true, locator: { kind: 'cycle-path', cycle: ['T1', 'T3', 'T2'] } }
  const claimBad = { kind: anchor.kind, path: 'project/deps.json', locator: { kind: 'cycle-path', cycle: ['T1', 'T2', 'T3'] } }
  const okVerdict = anchor.verify(claimOk, subject)
  const badVerdict = anchor.verify(claimBad, subject)
  assert.equal(okVerdict.status, 'anchored')
  assert.equal(okVerdict.tier, 'declared-locator')
  assert.deepEqual(okVerdict.nodes, ['T1', 'T3', 'T2'])
  assert.equal(badVerdict.status, 'unanchored', 'the reversed cycle must not anchor')

  const orphanClaim = { kind: anchor.kind, path: 'project/deps.json', declared: true, locator: { kind: 'orphan-task', taskId: 'T9' } }
  const orphanVerdict = anchor.verify(orphanClaim, subject)
  assert.equal(orphanVerdict.status, 'anchored')
  assert.deepEqual(orphanVerdict.nodes, ['T9'])

  // The verdict's own `path` IS the candidate path the plan admitted — which is
  // what makes the coverage number below follow from the graph rather than from a
  // number this test chose.
  const admittedPaths = new Set(plan.bundles.flatMap((item) => item.paths))
  assert.ok(admittedPaths.has('project/deps-task-t1.json'), 'the T1 node must have been admitted as a candidate')

  const anchoredFindings = [
    {
      id: 'f-cycle', path: okVerdict.path, start: okVerdict.start, severity: 'critical',
      claim: okVerdict.claim, nodes: okVerdict.nodes,
      message: 'T1/T2/T3 构成依赖环', evidence: JSON.stringify(okVerdict.graph), defended: true,
    },
    {
      id: 'f-orphan', path: 'project/deps-task-t9.json', start: orphanVerdict.start, severity: 'high',
      claim: orphanVerdict.claim, nodes: orphanVerdict.nodes,
      message: 'T9 没有上下游', evidence: JSON.stringify(orphanVerdict.graph), defended: true,
    },
  ]
  const panel = runCritiquePanel(anchoredFindings, { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.equal(panel.kept.length, 2, 'precision-first must keep both — each carries the graph-derived evidence')

  const proof = coverage(plan.gate.admitted, panel.kept, { requireComplete: pack.lossOrientation === 'recall-first' })
  assert.equal(proof.total, plan.gate.admitted)
  assert.equal(proof.reviewed, 2, 'two distinct admitted paths were adjudicated')
  assert.equal(proof.coverageRate, Number((2 / plan.gate.admitted).toFixed(4)))
  assert.equal(proof.complete, false, 'nine admitted candidates and two adjudicated is not complete coverage')
  assert.equal(proof.required, false, 'this domain is precision-first, so incomplete coverage is reported, not failed')

  const built = report({
    domain: pack,
    target: 'fixture cycle-and-orphan',
    scope: { admitted: plan.gate.admitted, excluded: plan.gate.excluded.length, bundles: plan.bundles.length },
    findings: panel.kept,
    coverageProof: proof,
    budget: { toolCalls: 0, tokens: 0, note: 'no model call in this fixture' },
    critiqueResult: panel,
  })
  assert.equal(built.coverage.coverageRate, proof.coverageRate)
  assert.equal(built.criticismKind, 'fact-checker')
})

await testAsync('integration: the engine hands this domain\'s verifier the real graph locator', async () => {
  // This block used to record a DOCUMENTED SUBSTRATE GAP: `recomputeAnchor` in
  // `index.js` rebuilt the claim from the engine's generic anchor vocabulary
  // (`{kind, path, locator:{start,startLine,end,endLine}, excerpt}`), dropping
  // `finding.locator`, and `toDocuments` reduced each document to `{path,content}`,
  // dropping `payload`. A text anchor survives that reduction; a GRAPH anchor does
  // not — its whole content is `locator`'s `kind`/`from`/`to` plus the document's
  // payload. So every graph-domain finding reached its own verifier as an empty
  // claim and reported zero coverage.
  //
  // FIXED by t17 (architect): the caller's `locator` is now passed through VERBATIM
  // and the top-level `start`/`end` are injected only when no locator was supplied.
  // F3's security property is not "the engine rebuilds the locator" — the engine
  // has no standing to rebuild a shape it does not understand. It is "the verdict
  // comes from the domain verifier". So this probe is now an ASSERTION OF THE FIX,
  // not a record of the defect. It is deliberately kept: this is the only assertion
  // in the suite that proves the ENGINE calls THIS verifier, and a future
  // refactor that reintroduces locator reconstruction would turn it red.
  const ctx = createPluginContext()
  const cyclic = fixture('cycle-and-orphan')
  // The engine normalises documents to `{path, content}`, so the graph must be in
  // the content. `payloadOf` in `_lib/graph.js` parses JSON out of `content` for
  // exactly this reason — a task graph is a documented JSON input format, and JSON
  // in a string is the same graph. Both spellings are exercised below.
  const asEngineSees = (entry) => ({ path: entry.path, content: JSON.stringify(entry.payload) })
  const documents = cyclic.input.payload.documents.map(asEngineSees)
  const graph = JSON.stringify(cyclic.input.payload.documents[0].payload)

  await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'integration',
    input: { format: cyclic.input.format, payload: cyclic.input.payload },
  }, {})

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: DOMAIN,
    target: 'integration',
    documents,
    findings: [
      {
        id: 'f-cycle',
        path: 'project/deps.json',
        locator: { kind: 'cycle-path', cycle: ['T1', 'T3', 'T2'] },
        severity: 'critical',
        message: 'T1/T2/T3 相互阻塞',
        evidence: graph,
        defended: true,
      },
      {
        id: 'f-orphan',
        path: 'project/deps.json',
        locator: { kind: 'orphan-task', taskId: 'T9' },
        severity: 'high',
        message: 'T9 既不依赖谁，也没有被谁依赖',
        evidence: graph,
        defended: true,
      },
      {
        id: 'f-reversed',
        path: 'project/deps.json',
        locator: { kind: 'task-edge', from: 'T1', to: 'T2' },
        severity: 'critical',
        message: '方向声明反了',
        evidence: graph,
        defended: true,
      },
    ],
  }, {})

  // The engine reports which path produced the verdict. `anchorVerifier` — not the
  // generic text fallback — is the whole point: it means the pack's own graph
  // verifier ran.
  assert.equal(submitted.anchorVia, 'anchorVerifier', 'the engine must route through the pack anchorVerifier')
  assert.equal(submitted.unanchored, 1, 'exactly the reversed edge must fail to anchor')
  assert.equal(submitted.findings.length, 2, 'the cycle and the orphan must be anchored')
  for (const finding of submitted.findings) {
    // `declared-locator`, not `recomputed-unique` — and the distinction is the
    // point of the assertion rather than a detail of it.
    //
    // The captain's ruling on t9 settled the judgement: `declared-locator` means
    // "the locator the CALLER supplied was independently confirmed by the
    // verifier", NOT "the engine set a flag saying so". An earlier version of this
    // domain read a `claim.declared` bit that nothing ever set, so every claim fell
    // to `recomputed-unique` — whose contract meaning is "the locator was missing or
    // wrong, and the verifier had to re-derive the position from quoted text". That
    // was false here: the caller supplied `{kind, cycle}` / `{kind, taskId}`, the
    // graph confirmed them, and nothing was re-derived. Nine already-migrated
    // domains infer the tier the same way.
    //
    // If this ever drops to `recomputed-unique`, either the engine stopped passing
    // the locator through or the verifier stopped reading it — both real regressions.
    assert.equal(finding.anchorTier, 'declared-locator')
    assert.ok(TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier))
  }
  // The one refusal, and its REASON — not merely "something was unanchored".
  const refused = submitted.unanchoredDetails.find((entry) => entry.id === 'f-reversed')
  assert.ok(refused !== undefined, 'the reversed edge must appear in unanchoredDetails')
  assert.equal(refused.tier, 'locator-mismatch')
  assert.equal(refused.via, 'anchorVerifier')
  assert.match(refused.detail, /反向边/u)
  assert.match(refused.detail, /拒绝按方向猜测/u)

  // Coverage must be computed from the ANCHORED paths, not from the admitted
  // count. Both findings anchor on the same candidate path, so this is 1 of 8 —
  // and `total` is the admitted CANDIDATE count for this domain, which the engine
  // derived from the plan the domain itself enumerated. Asserting the relationship
  // rather than the number keeps this honest if the fixture grows.
  assert.equal(submitted.coverage.totalSource, 'plan')
  assert.equal(submitted.coverage.reviewed, 1, 'two findings on one path is one reviewed path')
  assert.equal(submitted.coverage.coverageRate, 1 / submitted.coverage.total)
  assert.ok(submitted.coverage.total > submitted.coverage.reviewed)
  assert.equal(submitted.coverage.complete, false)
  assert.match(submitted.summary, /未锚定/u)
  assert.match(submitted.summary, /anchorVerifier/u)
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  const listed = await ctx.__tools.get(`adjudicate_project_management_rules`).execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    const name = evidenceToolName(DOMAIN, tool.name)
    assert.ok(ctx.__tools.has(name), `${name} must be registered on activation`)
  }
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: DOMAIN }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName(DOMAIN, tool.name)), false)
  }
})

await testAsync('the registered evidence tool is bounded end to end through the plugin', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  const tool = ctx.__tools.get(evidenceToolName(DOMAIN, 'graph_edges'))
  const many = {
    path: 'project/big.json',
    payload: { tasks: Array.from({ length: 300 }, (_, index) => ({ id: `N${index}`, dependsOn: ['N0'] })) },
  }
  const result = await tool.execute({ corpus: [many] }, {})
  assert.equal(result.truncated, true)
  assert.ok(result.items.length <= 100)
  assert.equal(result.domain, DOMAIN)
  assert.match(result.summary, /截断/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'replacement probe',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})
  // v1 declared the string 'workstream', which the v2 gate rejects outright. The
  // resolver is what makes the migration real rather than a rename — and the proof
  // that it is real is the GROUPING, not the `applied` flag: every candidate of the
  // cart workstream must land in one bundle together.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'workstream')
  const cart = plan.bundles.find((item) => item.key === 'ws/cart')
  assert.ok(cart !== undefined, `expected ws/cart among ${plan.bundles.map((item) => item.key).join(', ')}`)
  assert.ok(cart.paths.length > 1, 'a single-entry bundle would mean P2 did nothing')
  assert.ok(cart.paths.every((path) => path.startsWith('project/plan-')), 'the bundle must hold this stream only')

  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19, 'replacement must not change the domain count')
  assert.ok(listed.directory.replaced.includes(DOMAIN), `expected ${DOMAIN} to be reported as replaced: ${JSON.stringify(listed.directory.replaced)}`)
})

await testAsync('caller-supplied candidates reach bundleKey.resolve with their own metadata intact', async () => {
  // This test was WRITTEN ON A DEGRADED PATH and has been corrected. The engine's
  // `toCandidates` used to rebuild each candidate from a seven-field allow-list
  // (`path/bytes/additions/deletions/binary/deleted/key`) BEFORE `planFor` handed it
  // to `bundleKey.resolve`, so `meta` never arrived and a caller-supplied candidate
  // could not be grouped by anything but the path. The old version of this test
  // asserted that fallback as though it were the design — "a real limitation,
  // asserted rather than left implicit". It was not a limitation of this domain; it
  // was the engine deleting the input. t17 fixed `toCandidates` to spread every
  // field, so the assertion is now the opposite one: the domain's own resolver must
  // receive the metadata and group by it.
  //
  // Note what this proves that a domain-sourced run cannot: `adjudication_plan`
  // consumed no `input`, so the candidates came from the CALLER and the engine did
  // the normalising. Same resolver, same grouping, different door.
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'caller-supplied probe',
    candidates: [
      { path: 'project/a-task-1.json', meta: { workstream: 'core' } },
      { path: 'project/a-task-2.json', meta: { workstream: 'core' } },
      { path: 'project/b-task-1.json', meta: { workstream: 'edge' } },
      { path: 'project/b-task-2.json', meta: { workstream: 'edge' } },
    ],
  }, {})
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['ws/core', 'ws/edge'])
  assert.ok(plan.bundles.every((item) => item.paths.length === 2), 'the resolver must group the two candidates of each workstream together')
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'workstream')
})

await testAsync('an explicit candidate key wins over the domain resolver, and is reported as the caller\'s', async () => {
  // The other half of the same contract: a candidate that carries its OWN key is the
  // caller's decision, and the pack must not overwrite it. `applied:false` /
  // `source:'entry'` is the honest report — and the grouping must be the caller's
  // keys, not the resolver's, which is why the two candidates below deliberately
  // share a workstream yet land in different bundles.
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'explicit-key probe',
    candidates: [
      { path: 'project/a-task-1.json', key: 'ws/cart', meta: { workstream: 'cart' } },
      { path: 'project/a-task-2.json', key: 'ws/cart', meta: { workstream: 'cart' } },
      { path: 'project/a-task-3.json', key: 'ws/tools', meta: { workstream: 'cart' } },
      { path: 'project/a-task-4.json', key: 'ws/tools', meta: { workstream: 'cart' } },
    ],
  }, {})
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['ws/cart', 'ws/tools'])
  assert.ok(plan.bundles.every((item) => item.paths.length === 2))
  assert.equal(plan.bundleKey.applied, false)
  assert.equal(plan.bundleKey.source, 'entry')
})

await testAsync('the resolver falls back deterministically when a candidate carries no workstream', async () => {
  // A candidate CAN legitimately arrive without the metadata the resolver prefers —
  // a caller that supplies only paths. The requirement is not that this is
  // impossible; it is that the fallback is TOTAL and DETERMINISTIC (same input, same
  // key, every run), because an unstable key would make the bundle set depend on run
  // order and the bundling assertions above meaningless.
  const ctx = createPluginContext()
  const candidates = [
    { path: 'project/orphan-a-task.json' },
    { path: 'project/orphan-b-task.json' },
    { path: 'other/loose-c-task.json' },
    { path: 'other/loose-d-task.json' },
  ]
  const first = await ctx.__tools.get('adjudication_plan').execute({ domain: DOMAIN, target: 'fallback-1', candidates }, {})
  const second = await ctx.__tools.get('adjudication_plan').execute({ domain: DOMAIN, target: 'fallback-2', candidates }, {})
  assert.deepEqual(first.bundles.map((item) => item.key), second.bundles.map((item) => item.key))
  assert.equal(first.bundleKey.applied, true)
  // No candidate carried a key, so every key came from the resolver — and none of
  // them may be the path itself, which would mean the fallback collapsed to `path`.
  for (const bundle of first.bundles) {
    assert.ok(!bundle.paths.includes(bundle.key), `bundle key must not be a candidate path: ${bundle.key}`)
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(64)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log(`\nfailed: ${failedTitles.join(' | ')}`)
  process.exitCode = 1
}
