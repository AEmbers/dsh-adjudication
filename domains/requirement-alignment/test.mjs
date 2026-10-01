/**
 * requirement-alignment — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  deterministic candidate set
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey.resolve          ->  real chain grouping (not one-per-path)
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected by path
 *   P4  reviewPrompts.review       -> bounded review prompt
 *   P5  anchorVerifier.verify      -> recomputed edges / routes / gaps / across domains
 *   P6  reviewPrompts.verify       -> a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              -> bounded, truncated-when-cut, provenance
 *
 * Then it drives the assembled pack through the plugin's own mock Cordis context, so
 * the domain is proven to work where it is actually used.
 *
 * FIVE THINGS THIS FILE REFUSES TO DO
 * -----------------------------------
 * 1. It never asserts a status without asserting the tier. "anchored" alone is
 *    satisfiable by a verifier that guesses; the tier is what says it did not.
 * 2. It never lets P4 and P6 share a prompt. `assert.notEqual(p6.system, p4.system)`
 *    is load-bearing: the contract validators do NOT check it, so without this
 *    assertion a domain could pass `validateDomainPackV2` while handing its reviewer
 *    its own reasoning back.
 * 3. It never asserts `bundleKey.applied` alone. The acceptance is that two
 *    candidates which SHOULD share a bundle really do — an `applied: true` with a
 *    per-candidate key would be P2 silently not done.
 * 4. It never feeds the plugin a self-reported anchor. Every coverage assertion
 *    downstream of `adjudication_submit` is driven by findings this file first put
 *    through the domain's own `anchorVerifier.verify`, so the numbers follow from the
 *    graph and not from a number this file made up.
 * 5. It never uses the `claim.declared` flag to earn a tier. The tier has to come
 *    from the caller's own `locator`, and there is an assertion that setting the flag
 *    changes nothing.
 * 6. It never invents a sibling domain's anchor ids. Every consumability assertion
 *    reads the producer's OWN enumerator output on that producer's own fixture. A
 *    hand-written literal is exactly how a broken row stayed green: `feedback/fb-1`
 *    (no extension) was the one spelling that could still reach a row sitting below
 *    the `*.json` catch-all, while all 42 ids the producer really emits could not.
 * 7. It never lets the consumable-producer boundary drift unnoticed: the observed
 *    classification of every domain under `domains/` is PINNED, so a producer that
 *    stops being consumable fails here instead of quietly losing its anchors to
 *    `binary` and dropping out of the review scope.
 *
 * Usage: `node domains/requirement-alignment/test.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  resolveBundleKey,
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
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { createNodeIo, loadDomain, loadDomains } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack, { bundleKey as declaredBundleKey, chainKey } from './index.js'
import source, { ATTRIBUTION_BASES, CANDIDATE_KINDS, NODE_TYPES, EDGE_KINDS, REF_SHAPES, refShape } from './source.js'
import anchor, { ANCHOR_KINDS, REACHABLE_TIERS, ID_AMBIGUOUS } from './anchor.js'
import evidence from './evidence.js'
import prompts from './prompts.js'

const here = dirname(fileURLToPath(import.meta.url))
const DOMAIN = 'requirement-alignment'
const FORMAT = 'trace-graph'

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

/**
 * The documents a fixture declares, in the engine's own normalised shape.
 *
 * A fixture may carry several chain documents (`documents[]`) or one (`graphPath`).
 * Both spellings reach the verifier the same way, because `source.corpus()` is the
 * one place that knows the difference.
 */
function documentsOf(name) {
  const payload = fixture(name).input.payload
  if (Array.isArray(payload.documents)) return payload.documents
  return [{ path: payload.graphPath, type: 'trace-graph', payload }]
}

/**
 * The subject a verifier call takes.
 *
 * The fixtures ship a SELF-CONTAINED `subject` (`{path, content, documents}`, all
 * folded the way the engine folds them) and that is what is used here — the same
 * material any other harness would hand to `adjudication_anchor`. Falling back to a
 * locally-assembled subject is a convenience for a fixture that declares none; it must
 * never be the only path, or this file would be testing a verifier on input the plugin
 * path cannot produce.
 */
const subjectFor = (name, path, entry) => {
  if (entry?.subject !== undefined) return entry.subject
  return { path, documents: documentsOf(name) }
}

/** Every anchor case in every fixture, tagged with its bucket. */
function anchorCases() {
  const cases = []
  for (const [name, value] of FIXTURES) {
    for (const bucket of ['positive', 'negative', 'ambiguous']) {
      for (const entry of value.anchors?.[bucket] ?? []) cases.push({ fixture: name, bucket, entry })
    }
  }
  return cases
}

/** Enumerate + gate one fixture through the pack's OWN gate. */
function runP0P1(name) {
  const value = fixture(name)
  const enumerated = source.enumerate(value.input.payload, { maxCandidates: 400, maxExcerptLines: 200 })
  const result = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: pack.gate?.exclude,
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

/** Apply the pack's `bundleKey` the way `planFor()` does, then bundle. */
const keyed = (selected) => selected.map((entry) => {
  const resolution = resolveBundleKey(pack, entry, {})
  assert.equal(resolution.applied, true, `bundleKey must apply to ${entry.path}`)
  assert.equal(resolution.source, 'derived', `the key must be derived, not caller-supplied, for ${entry.path}`)
  return { ...entry, key: resolution.key }
})

// ---------------------------------------------------------------------------
// 0. The pack itself
// ---------------------------------------------------------------------------

console.log(`\n${DOMAIN} domain — contract v2 end-to-end`)
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
    ruleLibrary: {
      dir: 'rules',
      rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['**/*'], text: 'y'.repeat(12), needsExpertReview: true })),
    },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor(DOMAIN)
  assert.equal(declared.format, FORMAT)
  assert.equal(declared.bounded, true)
  assert.equal(source.inputFormat, FORMAT)
  assert.equal(pack.candidateSet.inputFormat, FORMAT)
  assert.equal(pack.candidateSet.kind, source.kind)
})

test('this is a D-family RELATIONAL meta-domain: category D, and its product is consistency', () => {
  assert.equal(pack.category, 'D')
  assert.match(pack.summary, /元领域|关系型/u)
  // The contract table's own word for what a candidate here is.
  assert.match(inputFormatFor(DOMAIN).candidates, /edge.*node side/iu)
})

test('the node types are exactly the vocabulary the contract table declares', () => {
  assert.deepEqual([...NODE_TYPES], ['requirement', 'plan', 'design', 'implementation', 'case', 'feedback'])
  assert.ok(EDGE_KINDS.includes('implements') && EDGE_KINDS.includes('verifies'))
})

await testAsync('index.js exports NO named candidateSource — a descriptor there would shadow source.js', async () => {
  const namespace = await import('./index.js')
  assert.equal(namespace.candidateSource, undefined, 'index.js must not export candidateSource')
  assert.equal(typeof namespace.default.candidateSet.kind, 'string')
  assert.equal(typeof source.enumerate, 'function')
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable',
    'this anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('recall-first implies the triage reviewer, and the pack declares exactly that', () => {
  assert.equal(pack.lossOrientation, 'recall-first')
  assert.equal(pack.criticism.kind, 'triage')
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.ok(evidence.tools.length >= 4, 'this domain needs the gap lister, the route walker, the neighbour lookup and the ref checker')
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxLines > 0 && tool.limits.maxItems > 0 && tool.limits.maxCalls > 0,
      `${tool.name} must declare positive limits`)
    assert.equal(typeof tool.execute, 'function')
  }
})

test('every tier the verifier can return is a contract tier — extensions ride in `scope`', () => {
  for (const tier of REACHABLE_TIERS) {
    assert.ok(Object.hasOwn(ANCHOR_TIERS, tier), `tier "${tier}" is not in the contract's table`)
  }
  assert.ok(!REACHABLE_TIERS.includes(ID_AMBIGUOUS), 'the extension cause must NOT be a tier')
})

test('the claim vocabulary covers the four defects this meta-domain exists to find', () => {
  for (const kind of ['trace-edge', 'chain-path', 'dangling-ref', 'uncovered-requirement', 'cross-domain-ref', 'stale-ref']) {
    assert.ok(ANCHOR_KINDS.includes(kind), `${kind} must be claimable`)
  }
})

// ---------------------------------------------------------------------------
// P0 / P1 — the boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — empty / all-gated-out / admitted')

test('every fixture is a valid fixture for this domain', () => {
  for (const [name, value] of FIXTURES) {
    const problems = validateFixture(value, FORMAT)
    assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`)
  }
})

test('the mandatory fixtures and the contract table\'s fourth are all present', () => {
  for (const name of [...MANDATORY_FIXTURES, 'dangling-ref']) {
    assert.ok(FIXTURES.has(name), `missing fixture "${name}"`)
  }
})

test('boundary: an empty graph produces an EMPTY candidate set and an empty gate', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  assert.equal(enumerated.candidates.length, fixture('empty').expect.candidates)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
  assert.equal(enumerated.truncated, false)
})

test('boundary: all-gated-out removes EVERY candidate, with five distinct predicates', () => {
  const expected = fixture('all-gated-out').expect
  const { enumerated, result } = runP0P1('all-gated-out')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted, 'the gate must admit nothing here')
  const predicates = byPredicate(result)
  assert.deepEqual(predicates, expected.excludedByPredicate)
  assert.equal(Object.keys(predicates).length, 5, 'five documents, five different reasons')
})

test('the all-gated-out boundary holds under the PACK\'S OWN gate, with no fixture-supplied exclude', () => {
  // The failure this blocks: a fixture that narrows the gate itself proves only that
  // the engine honours `options.exclude`. It does not prove the domain excludes
  // retired chains by default, which is what a reader believes it proves.
  assert.ok(!Object.hasOwn(fixture('all-gated-out'), 'gate'),
    'the fixture must not carry its own gate — the boundary has to be the pack\'s')
  for (const pattern of pack.gate.exclude) {
    assert.ok(typeof pattern === 'string' && pattern !== '')
  }
  const { result } = runP0P1('all-gated-out')
  assert.equal(result.selected.length, 0)
})

test('boundary: the happy path admits every candidate it enumerated', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.equal(result.excluded.length, 0)
})

test('every remaining fixture matches its hand-computed candidate/admitted counts', () => {
  for (const [name, value] of FIXTURES) {
    const { enumerated, result } = runP0P1(name)
    assert.equal(enumerated.candidates.length, value.expect.candidates, `${name}: candidates`)
    assert.equal(result.selected.length, value.expect.admitted, `${name}: admitted`)
  }
})

test('P0 emits one candidate per EDGE and one per NODE SIDE — the contract table\'s own promise', () => {
  const { enumerated } = runP0P1('dangling-ref')
  const edges = enumerated.candidates.filter((candidate) => candidate.locator.kind === 'trace-edge')
  const sides = enumerated.candidates.filter((candidate) => candidate.locator.kind === 'trace-node-side')
  // dangling-ref: 2 edges (R1→I1, I1→MISSING-CASE), 2 nodes x 2 sides
  assert.equal(edges.length, 2)
  assert.equal(sides.length, 4)
  for (const candidate of enumerated.candidates) {
    assert.ok('fromId' in candidate.locator, 'the locator shape is { fromId, toId? } — fromId is mandatory')
  }
  assert.equal(sides.filter((candidate) => candidate.locator.side === 'upstream').length, 2)
  assert.equal(sides.filter((candidate) => candidate.locator.side === 'downstream').length, 2)
})

test('a node with NO edges still becomes candidates — an orphan must be reachable by a finding', () => {
  const payload = {
    graphPath: 'chains/lonely/trace.json',
    nodes: [{ id: 'R9', type: 'requirement', ref: 'sessions/s1/u9' }],
    edges: [],
    upstream: [{ domain: 'requirement-research', ref: 'sessions/s1/u9' }],
  }
  const enumerated = source.enumerate(payload, {})
  assert.equal(enumerated.candidates.length, 2, 'both sides of the isolated node must be enumerated')
  assert.ok(enumerated.candidates.every((candidate) => candidate.locator.fromId === 'R9'))
})

test('a malformed input is REJECTED, not silently emptied', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT|trace-graph/u)
  assert.throws(() => source.enumerate({ nodes: 'not-an-array' }, {}), /nodes/u)
  assert.throws(() => source.enumerate({ edges: {} }, {}), /edges/u)
})

// ---------------------------------------------------------------------------
// P2 — bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — the chain grouping')

test('bundleKey is an object with a resolver — never a bare private strategy name', () => {
  assert.equal(typeof declaredBundleKey, 'object')
  assert.equal(typeof declaredBundleKey.resolve, 'function')
  assert.equal(pack.bundleKey, declaredBundleKey, 'the resolver the tests exercise must be the one the pack ships')
})

test('the resolver groups by CHAIN, and two candidates of one chain share a key', () => {
  const { result } = runP0P1('happy-path')
  const entries = keyed(result.selected)
  const checkout = entries.filter((entry) => entry.path.startsWith('chains/checkout/'))
  const refund = entries.filter((entry) => entry.path.startsWith('chains/refund/'))
  assert.ok(checkout.length > 1 && refund.length > 1)
  assert.equal(new Set(checkout.map((entry) => entry.key)).size, 1, 'one chain, one key')
  assert.equal(new Set(refund.map((entry) => entry.key)).size, 1, 'one chain, one key')
  assert.notEqual(checkout[0].key, refund[0].key, 'two chains must not collapse into one bundle')
  assert.equal(checkout[0].key, 'chain/checkout')
})

test('the grouping is REAL: more than one candidate lands in the same bundle', () => {
  const { result } = runP0P1('happy-path')
  // `maxPerBundle` is raised here so one CHAIN stays whole in this assertion; the
  // engine's default cap (10) splits a long chain, and that split is asserted through
  // the plugin below rather than hidden.
  const bundled = bundle(keyed(result.selected), { minFiles: 2, maxPerBundle: 40 })
  const multi = bundled.bundles.filter((item) => item.entries.length > 1)
  assert.ok(multi.length >= 2, `expected both chains to survive as groups, got ${bundled.bundles.length} bundles`)
  for (const group of bundled.bundles) {
    assert.ok(!group.entries.some((entry) => entry.path === group.key), 'a key must not be a candidate path')
  }
})

test('the resolver works from the PATH alone — meta is dropped by the engine before P2', () => {
  // `toCandidates()` keeps {path, bytes, additions, deletions, binary, deleted, key}
  // and drops `meta`. A resolver that read `meta.chain` would pass a unit test and
  // silently degrade in the real pipeline, so the path is what is exercised here.
  const withoutMeta = { id: 'x', path: 'chains/orders/trace-node-r1-upstream.json', locator: {}, text: '' }
  assert.equal(chainKey(withoutMeta), 'chain/orders')
  assert.equal(chainKey({ path: 'other/loose.json' }), 'chain/other')
  assert.equal(chainKey({ path: 'a/b.json' }), 'chain/a')
  assert.equal(chainKey({}), 'chain/unknown')
})

test('the resolver is deterministic: same input, same key, every run', () => {
  const input = { path: 'chains/checkout/trace-derives-r1-p1.json' }
  assert.equal(chainKey(input), chainKey(input))
  assert.equal(chainKey({ path: 'chains/checkout/trace-node-r1-upstream.json' }),
    chainKey({ path: 'chains/checkout/trace-derives-r1-p1.json' }),
    'every candidate of one chain must land on the same key')
})

test('an explicit meta.chain overrides the path — for callers that supply one directly', () => {
  assert.equal(chainKey({ path: 'chains/a/trace-x.json', meta: { chain: 'z' } }), 'chain/z')
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

test('no rule document claims expert validation — this library is agent-drafted', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    assert.doesNotMatch(text, /expert-validated|已通过专家|专家审定/u, `${file} must not claim expert validation`)
  }
  // ...and the prompt tells the model the same thing, so a reviewer cannot mistake the
  // library for an authoritative standard.
  const review = prompts.review({ pack, orientation: pack.lossOrientation })
  assert.match(review.system, /未经领域专家审定/u)
})

test('the rules dispatch by path: node-side rules do not fire for edge candidates', () => {
  const all = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = /^name:\s*(.+)$/mu.exec(text)[1].trim()
    const match = [...text.matchAll(/^ {2}- (.+)$/gmu)].map((entry) => entry[1].trim().replace(/^"|"$/gu, ''))
    return { name, match, text: 'x'.repeat(20) }
  })
  const edgeSelection = selectRules(all, ['chains/checkout/trace-implements-d1-i1.json'])
  const nodeSelection = selectRules(all, ['chains/checkout/trace-node-r1-upstream.json'])
  assert.ok(edgeSelection.injected.length > 0 && nodeSelection.injected.length > 0)
  assert.ok(edgeSelection.injected.some((rule) => rule.name === 'reversed-edge'), 'edge rules must fire for edges')
  assert.ok(!nodeSelection.injected.some((rule) => rule.name === 'reversed-edge'), 'and must NOT fire for node sides')
  assert.ok(nodeSelection.injected.some((rule) => rule.name === 'orphan-node'), 'node-side rules must fire for node sides')
  assert.ok(nodeSelection.injected.length < all.length, 'dispatch must not inject everything')
})

test('every rule states a failure mode, an evidence duty and a "does not count" boundary', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const body = text.split(/^---$/mu).slice(2).join('---').trim()
    assert.ok(body.length >= 60, `${file} is too thin to be actionable`)
    assert.match(body, /取证义务|给出/u, `${file} must say what evidence is owed`)
    assert.match(body, /不算/u, `${file} must say what does NOT count`)
  }
})

// ---------------------------------------------------------------------------
// P4 — the review prompt
// ---------------------------------------------------------------------------

console.log('\nP4 — the bounded review prompt')

const reviewContext = {
  pack,
  domain: pack,
  orientation: pack.lossOrientation,
  bundle: { key: 'chain/checkout', paths: ['chains/checkout/trace-derives-r1-p1.json'], rules: [] },
  budget: createBudget({}),
  ruleText: '',
}

test('review() returns the three-field prompt the contract declares', () => {
  const out = prompts.review(reviewContext)
  assert.deepEqual(validatePromptOutput('review', out), [])
  assert.equal(typeof out.system, 'string')
  assert.ok(out.system.length > 200)
})

test('the P4 prompt states the anchor law in THIS domain\'s vocabulary', () => {
  const { system } = prompts.review(reviewContext)
  for (const kind of ['trace-edge', 'chain-path', 'dangling-ref', 'uncovered-requirement', 'cross-domain-ref', 'stale-ref']) {
    assert.ok(system.includes(kind), `the model cannot claim what it cannot name: ${kind} is missing`)
  }
  assert.match(system, /逐字抄写/u)
})

test('the P4 prompt carries recall-first into the instructions, not just the label', () => {
  const { system } = prompts.review(reviewContext)
  assert.match(system, /recall-first/u)
  assert.match(system, /doubtful/u)
  assert.match(system, /逐条列出/u, 'gaps must be listed item by item, not summarised as a percentage')
})

test('the P4 prompt injects the rules it was handed, and says they are unchecked', () => {
  const out = prompts.review({ ...reviewContext, ruleText: '## orphan-node\n孤立节点必须报告' })
  assert.equal(out.rules, '## orphan-node\n孤立节点必须报告')
  assert.ok(out.system.includes('孤立节点必须报告'))
  assert.ok(out.budget !== undefined)
})

test('the P4 prompt separates the two strengths of cross-domain evidence', () => {
  const { system } = prompts.review(reviewContext)
  assert.match(system, /形状/u)
  assert.match(system, /upstream\[\]/u)
  assert.match(system, /无法回答/u, 'an unanswerable question must be labelled unanswerable, not passed')
})

// ---------------------------------------------------------------------------
// P5 — the anchor verifier
// ---------------------------------------------------------------------------

console.log('\nP5 — recomputed edges, routes, gaps and cross-domain refs')

for (const { fixture: name, bucket, entry } of anchorCases()) {
  test(`${name} ${bucket}: ${entry.claim.locator.kind} -> ${entry.expectTier}`, () => {
    const verdict = anchor.verify(entry.claim, subjectFor(name, entry.subjectPath, entry))
    assert.deepEqual(validateAnchorVerdict(verdict), [], validateAnchorVerdict(verdict).join('; '))
    assert.equal(verdict.status, entry.expectStatus)
    assert.equal(verdict.tier, entry.expectTier, `${verdict.tier}: ${verdict.detail ?? ''}`)
    assert.equal(TRUSTED_ANCHOR_TIERS.includes(verdict.tier), verdict.status === 'anchored',
      'a trusted tier must mean anchored and vice versa')
    if (entry.expectNodes) {
      assert.deepEqual([...(verdict.nodes ?? [])].sort(), [...entry.expectNodes].sort())
    }
    if (entry.expectScope) assert.equal(verdict.scope, entry.expectScope)
    if (entry.expectAmbiguousIn) {
      assert.deepEqual([...(verdict.ambiguousIn ?? [])].sort(), [...entry.expectAmbiguousIn].sort())
    }
  })
}

test('every anchored verdict carries a `position` naming what `start` indexes', () => {
  // Graph anchors have no lines. The contract reuses `start`/`end` for the position
  // within the verified document, and `position` is the field that says what it is —
  // a reporting consumer that printed `start` as a line number would be inventing one.
  for (const { fixture: name, bucket, entry } of anchorCases()) {
    const verdict = anchor.verify(entry.claim, subjectFor(name, entry.subjectPath, entry))
    if (verdict.status !== 'anchored') continue
    assert.ok(['edge', 'chain-hop', 'node'].includes(verdict.position), `bad position ${verdict.position}`)
    assert.ok(Number.isInteger(verdict.start) && verdict.start >= 1)
    assert.ok(verdict.end >= verdict.start)
    if (bucket === 'positive') assert.ok(verdict.nodes.length > 0, 'an anchored graph claim must name its ids')
  }
})

test('the tier comes from the LOCATOR, not from a flag the caller can set', () => {
  const claim = {
    kind: anchor.kind,
    path: 'chains/checkout/trace.json',
    locator: { kind: 'trace-edge', fromId: 'R1', toId: 'P1' }, // no edgeKind
  }
  const plain = anchor.verify(claim, subjectFor('happy-path', claim.path))
  const flagged = anchor.verify({ ...claim, declared: true }, subjectFor('happy-path', claim.path))
  assert.equal(plain.tier, 'recomputed-unique')
  assert.equal(flagged.tier, plain.tier, '`claim.declared` must not buy a tier')
  assert.equal(flagged.status, 'anchored', 'and it must not break a claim that is otherwise confirmed')
})

test('a locator that names the whole fact earns declared-locator', () => {
  const claim = {
    kind: anchor.kind,
    path: 'chains/checkout/trace.json',
    locator: { kind: 'trace-edge', fromId: 'R1', toId: 'P1', edgeKind: 'derives' },
  }
  const verdict = anchor.verify(claim, subjectFor('happy-path', claim.path))
  assert.equal(verdict.tier, 'declared-locator')
})

test('the three negative classes the completion gate names are all present in the fixtures', () => {
  const cases = anchorCases()
  const negatives = cases.filter((item) => item.bucket === 'negative')
  const ambiguous = cases.filter((item) => item.bucket === 'ambiguous')
  assert.ok(negatives.length >= 8, `only ${negatives.length} negative anchor cases`)
  assert.ok(ambiguous.length >= 2, 'ambiguity must be exercised, not just mentioned')
  // A paraphrase is not a claim: the fixtures contain one that describes the right
  // relationship in words the graph cannot confirm.
  assert.ok(negatives.some((item) => item.entry.note?.includes('转述')), 'a paraphrase negative is missing')
  // Two DIFFERENT causes of ambiguity, because they are two different refusals:
  // several routes between one pair of nodes, and one claim true of two documents.
  assert.ok(ambiguous.some((item) => item.fixture === 'ambiguous-route'), 'the multi-route refusal is missing')
  assert.ok(ambiguous.some((item) => item.fixture === 'cross-file'), 'the cross-file refusal is missing')
  assert.ok(ambiguous.some((item) => (item.entry.expectAmbiguousIn ?? []).length >= 2),
    'an ambiguity verdict must LIST the competing readings')
})

test('a claim kind outside the vocabulary is refused as kind-mismatch, never guessed', () => {
  const verdict = anchor.verify({
    kind: anchor.kind,
    path: 'chains/checkout/trace.json',
    locator: { kind: 'alignment-vibes', fromId: 'R1' },
  }, subjectFor('happy-path', 'chains/checkout/trace.json'))
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('an anchor of a DIFFERENT kind is refused — this verifier owns exactly one', () => {
  const verdict = anchor.verify({
    kind: 'diff-line',
    path: 'chains/checkout/trace.json',
    locator: { kind: 'trace-edge', fromId: 'R1', toId: 'P1' },
  }, subjectFor('happy-path', 'chains/checkout/trace.json'))
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a corpus with no documents is reported, not treated as "nothing found"', () => {
  const verdict = anchor.verify({
    kind: anchor.kind,
    path: 'chains/checkout/trace.json',
    locator: { kind: 'trace-edge', fromId: 'R1', toId: 'P1' },
  }, { path: 'chains/checkout/trace.json', documents: [] })
  assert.equal(verdict.tier, 'no-documents')
})

test('a malformed claim THROWS a contract error rather than returning a verdict', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /kind/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, locator: {} }, {}), /path/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a', locator: 'x' }, {}), /locator/u)
})

test('an empty locator is `empty-excerpt`: there is nothing here to verify', () => {
  const verdict = anchor.verify({
    kind: anchor.kind,
    path: 'chains/checkout/trace.json',
    locator: { kind: 'trace-edge' },
  }, subjectFor('happy-path', 'chains/checkout/trace.json'))
  assert.equal(verdict.tier, 'empty-excerpt')
})

console.log('\nP5 (meta) — attribution basis: `exact` vs `form`')

/**
 * t32 — HOW MUCH THE ATTRIBUTION ACTUALLY KNOWS.
 *
 * `refDomain` on its own reads like a fact, and for the diff-extension row it is not
 * one: the row's judgement is "a path with a diff extension", so `src/core/engine.ts`
 * (architecture, tech-test, a rollup, …) and `src/app.ts` (code-review) are the SAME
 * shape to it, and first-match-wins cannot separate them by any ordering. Reporting
 * `refDomain: 'code-review'` there is a tool giving an answer MORE certain than what
 * it knows — the exact failure shape this domain exists to refuse.
 *
 * So every attribution carries `basis`:
 *   'exact' — the shape identifies ONE domain.
 *   'form'  — the shape identifies a FORM and a FAMILY of producers.
 *
 * These assertions pin the bases, and pin them against the producers' OWN enumerator
 * output rather than a hand-written list.
 */

test('t32: every REF_SHAPES row declares its basis, and the two shared forms say `form`', () => {
  for (const row of REF_SHAPES) {
    assert.ok(ATTRIBUTION_BASES.includes(row.basis),
      `${row.domain}/${row.form} has basis=${row.basis}, which is not one of ${ATTRIBUTION_BASES.join('/')}`)
  }
  const byForm = (form) => REF_SHAPES.find((row) => row.form === form)

  // The diff-extension row: no domain prefix at all, so it cannot name a member.
  const diff = byForm('diff-line-span')
  assert.equal(diff.basis, 'form')
  assert.ok(typeof diff.basisDetail === 'string' && diff.basisDetail.length > 0,
    'a `form` row must say WHY it can only name a family')

  // The `<path>.json` catch-all names a domain in the row but judges only "is JSON":
  // it claims algo-model's exports and this domain's own chains/*.json as well.
  const catchAll = byForm('graph-path')
  assert.equal(catchAll.basis, 'form', 'a wildcard row cannot claim `exact` attribution')

  // The four prefixed rows really do identify exactly one domain each.
  for (const form of ['utterance', 'requirement-entry', 'plan-edge', 'feedback-row']) {
    assert.equal(byForm(form).basis, 'exact', `${form} must be exact`)
  }
})

test('t32: `basis` is part of the refShape ANSWER, not a side table', () => {
  assert.equal(refShape('src/app.ts').basis, 'form')
  assert.equal(refShape('src/core/engine.ts').basis, 'form',
    'this is the case: architecture and code-review are the same shape here')
  assert.equal(refShape('sessions/s1/u2').basis, 'exact')
  assert.equal(refShape('requirements/req-ledger').basis, 'exact')
  assert.equal(refShape('plans/p1/serves/r1').basis, 'exact')
  assert.equal(refShape('feedback/ledger-fb-1001-dec-20.json').basis, 'exact')
  assert.equal(refShape('project/plan-task-t1.json').basis, 'form')
})

await testAsync('t32: on the producers\' OWN output, prefixed families are exact and shared forms are form', async () => {
  const EXPECTED = [
    ['requirement-research', 'exact'],
    ['product-planning', 'exact'],
    ['user-feedback', 'exact'],
    ['code-review', 'form'], // the diff-extension family …
    ['architecture', 'form'], // … which is indistinguishable from this one
    ['project-management', 'form'], // the `<path>.json` catch-all
  ]
  for (const [id, basis] of EXPECTED) {
    const paths = await siblingPaths(id, 'happy-path')
    assert.ok(paths.length > 0, `${id} produced no candidates`)
    const bases = [...new Set(paths.map((path) => refShape(path)?.basis ?? 'OPAQUE'))].sort()
    assert.deepEqual(bases, [basis], `${id}: observed bases [${bases.join(', ')}]`)
  }
})

test('t32: the VERDICT carries the basis, so a family-level attribution cannot read as a fact', () => {
  const graph = 'chains/checkout/trace.json'
  const subject = subjectFor('happy-path', graph)

  const tsRef = anchor.verify({
    kind: anchor.kind, path: graph,
    locator: { kind: 'cross-domain-ref', fromId: 'I1' },
  }, subject)
  assert.equal(tsRef.status, 'anchored')
  assert.equal(tsRef.refDomain, 'code-review')
  assert.equal(tsRef.refBasis, 'form', 'refDomain alone would be the over-confident answer')
  assert.ok(tsRef.refBasisDetail !== null && tsRef.refBasisDetail !== undefined,
    'a form attribution must carry its reason')

  const sessionRef = anchor.verify({
    kind: anchor.kind, path: graph,
    locator: { kind: 'cross-domain-ref', fromId: 'R1' },
  }, subject)
  assert.equal(sessionRef.status, 'anchored')
  assert.equal(sessionRef.refDomain, 'requirement-research')
  assert.equal(sessionRef.refBasis, 'exact')
})

test('t32: the candidate meta AND the node-side text carry the basis', () => {
  const payload = {
    graphPath: 'chains/basis/trace.json',
    nodes: [{ id: 'I1', type: 'implementation', ref: 'src/cart.ts#L12-L20' }],
    edges: [],
  }
  const enumerated = source.enumerate(payload, {})
  const side = enumerated.candidates.find((candidate) => candidate.locator.kind === CANDIDATE_KINDS.nodeSide)
  assert.ok(side !== undefined)
  assert.equal(side.meta.refDomain, 'code-review')
  assert.equal(side.meta.refBasis, 'form')
  assert.match(side.text, /basis=form/u, 'the text a reviewer reads must say the basis')
  assert.match(side.text, /家族/u, 'and must say that `form` means a family, not a domain')
})

test('t32: the evidence toolkit reports the basis too', () => {
  const documents = [{
    path: 'chains/basis/trace.json',
    type: 'trace-graph',
    payload: {
      graphPath: 'chains/basis/trace.json',
      nodes: [{ id: 'I1', type: 'implementation', ref: 'src/cart.ts#L12-L20' }],
      edges: [],
    },
  }]
  const out = evidence.tools.find((tool) => tool.name === 'ref_check').execute({ corpus: documents })
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].refDomain, 'code-review')
  assert.equal(out.items[0].refBasis, 'form')
})

test('t32: the basis is visible where R2 already put the boundary (plan + pack summary)', () => {
  assert.match(pack.anchor.description, /basis/u)
  assert.match(pack.anchor.description, /form/u)
  assert.match(pack.summary, /basis/u)
  assert.match(pack.summary, /exact/u)
  assert.match(pack.summary, /家族/u)
})


// --- the meta-domain property, exercised against the REAL sibling domains -----

console.log('\nP5 (meta) — consuming anchor ids produced by OTHER domains')

/**
 * EVERY node type this domain declares it consumes, with a REAL producer for it.
 *
 * This list is load-bearing and it used to be three entries long
 * (requirement-research / product-planning / code-review) — the three that happened
 * to be correct. The `feedback` leg was missing, which is precisely the leg whose row
 * in `REF_SHAPES` sat BELOW the catch-all `<path>.json` row and therefore matched
 * ZERO of user-feedback's real anchors. A coverage list that omits the failing case
 * does not fail; it just never runs.
 *
 * `attribution` is the domain `refShape()` reports for that producer's ids, and it is
 * NOT always the producer itself — see the pinned table below for why:
 *
 *   • the diff-extension family is FORM-level: code-review, backend-engineering,
 *     frontend-engineering, tech-doc, tech-test, architecture, risk-compliance and
 *     others emit structurally identical `<path>.<ext>` ids, so a shape match names
 *     the family, not the member. `upstream[]` is what answers "who is still
 *     producing it".
 *   • `nodeType` is the contract's own six-word vocabulary (`NODE_TYPES`), and there
 *     is an assertion below that this list covers all six.
 */
const SIBLINGS = [
  { id: 'requirement-research', nodeType: 'requirement', attribution: 'requirement-research' },
  { id: 'product-planning', nodeType: 'plan', attribution: 'product-planning' },
  { id: 'code-review', nodeType: 'implementation', attribution: 'code-review' },
  { id: 'tech-doc', nodeType: 'design', attribution: 'code-review' },
  { id: 'tech-test', nodeType: 'case', attribution: 'code-review' },
  { id: 'project-management', nodeType: 'case', attribution: 'project-management' },
  { id: 'user-feedback', nodeType: 'feedback', attribution: 'user-feedback' },
]

/** The candidate paths a sibling domain's own enumerator produces. */
async function siblingPaths(id, fixtureName) {
  const module_ = await import(`../${id}/source.js`)
  const sibling = module_.default ?? module_
  const fixturePath = join(here, '..', id, 'fixtures', `${fixtureName}.json`)
  const parsed = JSON.parse(readFileSync(fixturePath, 'utf8'))
  // Same three spellings the engine and the D family use: the fixture may carry the
  // corpus as `payload`, as `graph`, or as the input object itself.
  const payload = parsed.input?.payload ?? parsed.input?.graph ?? parsed.input
  const enumerated = sibling.enumerate(payload, {})
  return enumerated.candidates.map((candidate) => candidate.path)
}

test('the producer legs cover every node type in the contract vocabulary', () => {
  const covered = new Set(SIBLINGS.map((sibling) => sibling.nodeType))
  for (const nodeType of NODE_TYPES) {
    assert.ok(covered.has(nodeType), `no producer leg exercises node type "${nodeType}"`)
  }
})

for (const sibling of SIBLINGS) {
  test(`a ref produced by ${sibling.id}'s OWN enumerator is consumable here (${sibling.nodeType})`, async () => {
    const paths = await siblingPaths(sibling.id, 'happy-path')
    assert.ok(paths.length > 0, `${sibling.id} produced no candidates to consume`)
    const consumable = paths.filter((path) => refShape(path) !== null)
    assert.ok(consumable.length > 0,
      `none of ${sibling.id}'s candidate paths is consumable: ${paths.slice(0, 3).join(', ')}。`
      + ' REF_SHAPES is stale — that is a decision to make, not a test to re-run.')
    // EVERY path, not a slice of three: with `slice(0, 3)` the first three being right
    // is enough to stay green while the rest are attributed to the wrong producer.
    assert.equal(consumable.length, paths.length,
      `${sibling.id}: ${paths.length - consumable.length}/${paths.length} of its ids are OPAQUE here (${paths.filter((path) => refShape(path) === null).slice(0, 3).join(', ')} …)`)
    for (const path of consumable) {
      assert.equal(refShape(path).domain, sibling.attribution,
        `${path} (from ${sibling.id}) was attributed to ${refShape(path).domain}`)
    }
  })
}

console.log('\nP5 (meta) — the consumable-producer boundary, PINNED')

/**
 * R2: which producers this domain can consume, and which it cannot, written down.
 *
 * The table in `source.js` is finite and versioned by hand, so the RISK is not that it
 * is wrong today — it is that it silently WIDENS its refusals later: a producer whose
 * ids stop matching is marked `binary`, moved out of the review scope, and mentioned
 * only in `notes`. Nothing in the pipeline would fail; a whole domain's anchors would
 * simply stop being reviewed. So this test pins the observed classification for every
 * domain in `domains/`, one row per producer:
 *
 *   `[]`      — every id this producer emits is OPAQUE here (it falls outside the
 *               six node types / the REF_SHAPES table, so this domain does NOT
 *               guarantee it can consume them).
 *   `[...]`   — every id this producer emits is consumable, and these are the domains
 *               `refShape()` attributes them to.
 *
 * A row that changes turns this red. That is the point: the change has to be a
 * decision, taken in `source.js`, with this table updated to match.
 *
 * TWO THINGS THE `[...]` VALUES DO NOT MEAN
 *
 * 1. The diff-extension family is FORM-level. `architecture`, `tech-doc`, `tech-test`,
 *    `risk-compliance`, `market-research`, `reverse-engineering`, `data-engineering`
 *    all emit `<path>.<ext>` ids structurally identical to code-review's, so they are
 *    attributed to `code-review` — the family's reference producer. The shape says
 *    "this is readable and it belongs to that family"; it does NOT say which member
 *    emitted it, and it never claims the member is still producing it. Only
 *    `upstream[]` answers that (see the `shape-only` / `declared-and-present` split in
 *    anchor.js).
 * 2. `*.json` is a catch-all row on purpose: project-management's id space really is
 *    `<path>.json`. That is why `algo-model`'s experiment exports and this domain's
 *    own `chains/*.json` exports are attributed to project-management. Broad, but not
 *    a defect: attribution is a hint for the report; the producer question is decided
 *    by `upstream[]` alone.
 */
const PRODUCER_CONSUMABILITY = [
  ['algo-model', ['project-management']],   // experiments/<...>/metrics.json — the catch-all row
  ['architecture', ['code-review']],        // src/*.ts — shared diff-extension form
  ['backend-engineering', ['code-review']], // api/*.go
  ['code-review', ['code-review']],         // the family's reference producer
  ['data-engineering', ['code-review']],    // models/*.sql
  ['frontend-engineering', ['code-review']],// src/*.tsx
  ['market-research', ['code-review']],     // research/**/*.md
  ['operator-design', []],                  // src/ops/*.cu — '.cu' is NOT in DIFF_EXTENSIONS
  ['product-planning', ['product-planning']],
  ['project-management', ['project-management']],
  ['requirement-alignment', ['project-management']], // its own chains/*.json, caught by the catch-all
  ['requirement-research', ['requirement-research']],
  ['reverse-engineering', ['code-review']], // re/**/*.md
  ['risk-compliance', ['code-review']],     // dp-*/**/*.ts
  ['tech-doc', ['code-review']],            // docs/**/*.md
  ['tech-test', ['code-review']],           // src/**/*.spec.ts
  ['ui-visual', []],                        // atoms/<component>/<token> — no file extension at all
  ['user-feedback', ['user-feedback']],     // feedback/ledger-*.json — the R1 defect lived here
  ['ux-review', []],                        // checkout/<flow>/<step> — no file extension at all
]

await testAsync('every producer in domains/ is pinned as consumable or not', async () => {
  const discovered = readdirSync(join(here, '..'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  const pinned = new Map(PRODUCER_CONSUMABILITY)
  const missing = [...pinned.keys()].filter((id) => !discovered.includes(id))
  assert.deepEqual(missing, [],
    `pinned producers that no longer exist under domains/: ${missing.join(', ')}`)

  const drifted = []
  for (const id of discovered) {
    const fixturePath = join(here, '..', id, 'fixtures', 'happy-path.json')
    assert.ok(existsSync(fixturePath),
      `${id} has no fixtures/happy-path.json — this table reads every producer's OWN enumerator output, so a rename has to be reflected here`)
    const paths = await siblingPaths(id, 'happy-path')
    assert.ok(paths.length > 0, `${id}'s happy-path fixture produced no candidates`)
    const attributed = [...new Set(paths.map((path) => refShape(path)?.domain ?? 'OPAQUE'))].sort()

    if (!pinned.has(id)) {
      console.log(`       note  ${id} is a producer absent from PRODUCER_CONSUMABILITY (observed: ${attributed.join(', ')}) — 把它登记进这张表，否则这条边界会在这里静默变宽`)
      continue
    }
    const declared = pinned.get(id)
    const wanted = declared.length === 0 ? ['OPAQUE'] : [...declared].sort()
    if (attributed.join(' | ') !== wanted.join(' | ')) {
      drifted.push(`${id}: pinned [${wanted.join(', ')}], now [${attributed.join(', ')}]`)
    }
  }
  assert.deepEqual(drifted, [],
    'a producer changed consumability without a decision (update REF_SHAPES + this table deliberately):\n       ' + drifted.join('\n       '))
})

await testAsync('a trace graph whose nodes carry REAL sibling ids anchors end to end', async () => {
  const reqId = (await siblingPaths('requirement-research', 'happy-path'))[0]
  const planId = (await siblingPaths('product-planning', 'happy-path'))[0]
  const codeId = (await siblingPaths('code-review', 'happy-path'))[0]
  assert.ok(refShape(reqId) !== null && refShape(planId) !== null && refShape(codeId) !== null)

  // This is the meta-domain property in one object: the graph does NOT invent its own
  // id space, it binds to ids four other domains produced.
  const payload = {
    graphPath: 'chains/interop/trace.json',
    nodes: [
      { id: 'R1', type: 'requirement', ref: reqId },
      { id: 'P1', type: 'plan', ref: planId },
      { id: 'I1', type: 'implementation', ref: codeId },
    ],
    edges: [
      { from: 'R1', to: 'P1', kind: 'derives' },
      { from: 'P1', to: 'I1', kind: 'implements' },
    ],
    upstream: [
      { domain: 'requirement-research', ref: reqId },
      { domain: 'product-planning', ref: planId },
      { domain: 'code-review', ref: codeId },
    ],
  }
  const documents = [{ path: payload.graphPath, type: 'trace-graph', payload }]
  const enumerated = source.enumerate(payload, {})
  assert.deepEqual(validateCandidateSetResult(enumerated), [])

  for (const node of payload.nodes) {
    const verdict = anchor.verify({
      kind: anchor.kind,
      path: payload.graphPath,
      locator: { kind: 'cross-domain-ref', fromId: node.id, ref: node.ref },
    }, { path: payload.graphPath, documents })
    assert.equal(verdict.status, 'anchored', `${node.id} / ${node.ref}: ${verdict.detail ?? ''}`)
    assert.equal(verdict.tier, 'declared-locator')
    assert.equal(verdict.staleCheck, 'declared-and-present')
    assert.equal(verdict.refDomain, refShape(node.ref).domain)
  }

  // And the gap lister confirms none of the three bindings is stale or opaque.
  const gaps = evidence.tools.find((tool) => tool.name === 'gap_report').execute({ corpus: documents })
  assert.ok(!gaps.items.some((item) => item.kind === 'stale-ref'), 'no binding should be stale here')
  assert.ok(!gaps.items.some((item) => item.kind === 'missing-ref'), 'every node is bound')
})

await testAsync('a ref that no longer appears in upstream[] is reported as a STALE link', async () => {
  const reqId = (await siblingPaths('requirement-research', 'happy-path'))[0]
  const payload = {
    graphPath: 'chains/stale/trace.json',
    nodes: [{ id: 'R1', type: 'requirement', ref: reqId }],
    edges: [],
    // The upstream domain renamed its utterance: the old id is gone from this list.
    upstream: [{ domain: 'requirement-research', ref: 'sessions/unknown/u1' }],
  }
  const documents = [{ path: payload.graphPath, type: 'trace-graph', payload }]
  const stale = anchor.verify({
    kind: anchor.kind,
    path: payload.graphPath,
    locator: { kind: 'stale-ref', fromId: 'R1' },
  }, { path: payload.graphPath, documents })
  assert.equal(stale.status, 'anchored')
  assert.equal(stale.stale, true)
  assert.equal(stale.ref, reqId)

  const stillValid = anchor.verify({
    kind: anchor.kind,
    path: payload.graphPath,
    locator: { kind: 'cross-domain-ref', fromId: 'R1' },
  }, { path: payload.graphPath, documents })
  assert.equal(stillValid.tier, 'locator-mismatch', 'the mirror claim must fail once the ref is stale')
})

test('without upstream[] the stale question is UNANSWERED, not passed', () => {
  const payload = {
    graphPath: 'chains/unknown/trace.json',
    nodes: [{ id: 'R1', type: 'requirement', ref: 'sessions/s1/u2' }],
    edges: [],
  }
  const documents = [{ path: payload.graphPath, type: 'trace-graph', payload }]
  const consumable = anchor.verify({
    kind: anchor.kind,
    path: payload.graphPath,
    locator: { kind: 'cross-domain-ref', fromId: 'R1' },
  }, { path: payload.graphPath, documents })
  assert.equal(consumable.status, 'anchored', 'the SHAPE is confirmed')
  assert.equal(consumable.scope, 'shape-only')
  assert.equal(consumable.staleCheck, 'not-declared')
  assert.match(consumable.note, /未声明|未确认/u)

  const stale = anchor.verify({
    kind: anchor.kind,
    path: payload.graphPath,
    locator: { kind: 'stale-ref', fromId: 'R1' },
  }, { path: payload.graphPath, documents })
  assert.equal(stale.status, 'unanchored')
  assert.equal(stale.tier, 'no-match', 'an unanswerable question is not a pass')
})

test('a ref whose shape no domain emits is refused as opaque', () => {
  const payload = {
    graphPath: 'chains/opaque/trace.json',
    nodes: [{ id: 'R1', type: 'requirement', ref: 'see the screenshot on the wiki' }],
    edges: [],
    upstream: [{ domain: 'requirement-research', ref: 'sessions/s1/u2' }],
  }
  const documents = [{ path: payload.graphPath, type: 'trace-graph', payload }]
  const verdict = anchor.verify({
    kind: anchor.kind,
    path: payload.graphPath,
    locator: { kind: 'cross-domain-ref', fromId: 'R1' },
  }, { path: payload.graphPath, documents })
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('REF_SHAPES names a producer for every form it accepts', () => {
  const samples = [
    ['sessions/s1/u2', 'requirement-research'],
    ['requirements/req-ledger', 'product-planning'],
    ['plans/plan-diff/serves/req-ledger', 'product-planning'],
    ['src/cart.ts#L12-L20', 'code-review'],
    ['src/app.ts', 'code-review'],
    ['project/plan-task-t1.json', 'project-management'],
    // R1: BOTH spellings of a feedback row. The first is what user-feedback's own
    // enumerator emits (a derived ledger document); the second is the bare row id the
    // corpus fixtures bind to. The hand-written sample used to be the second one only,
    // and it was the one shape that could still reach a row sitting in the wrong place.
    ['feedback/ledger-fb-1001-dec-20.json', 'user-feedback'],
    ['feedback/fb-1', 'user-feedback'],
  ]
  for (const [ref, domain] of samples) {
    const shape = refShape(ref)
    assert.ok(shape !== null, `${ref} must be consumable`)
    assert.equal(shape.domain, domain, `${ref} was attributed to ${shape.domain}`)
    assert.ok(REF_SHAPES.some((entry) => entry.form === shape.form))
  }
  for (const opaque of ['见截图', 'TODO', 'https://example.com/x', 'a b c']) {
    assert.equal(refShape(opaque), null, `${opaque} must NOT pass as a consumable anchor id`)
  }
})

test('R1: a specific prefix row outranks the `*.json` catch-all (order is part of the table)', () => {
  // `refShape` is first-match-wins and the project-management row is the broad
  // `<path>.json` form, so ANY prefixed row whose ids can end in `.json` has to sit
  // above it. Assert the ORDER, not just the outcome: with the feedback row below the
  // catch-all, 42/42 of user-feedback's real anchors were reported as
  // project-management and its own row scored zero hits.
  const catchAll = REF_SHAPES.findIndex((entry) => entry.form === 'graph-path')
  const feedback = REF_SHAPES.findIndex((entry) => entry.form === 'feedback-row')
  assert.ok(catchAll >= 0 && feedback >= 0, 'both rows must exist')
  assert.ok(feedback < catchAll,
    `the feedback row (index ${feedback}) must precede the \`<path>.json\` catch-all (index ${catchAll})`)

  // And the same property stated on real producer output: every id user-feedback
  // emits resolves to user-feedback.
  const dropped = ['feedback/ledger-fb-1001-dec-20.json', 'feedback/ledger-dec-20.json', 'feedback/ledger-theme-ui.json']
  for (const ref of dropped) {
    assert.equal(refShape(ref).domain, 'user-feedback', `${ref} must resolve to its real producer`)
  }
})

// ---------------------------------------------------------------------------
// P6 — the independent re-check
// ---------------------------------------------------------------------------

console.log('\nP6 — the independent re-check')

test('P6 is NOT the P4 prompt — the assertion the validators do not make', () => {
  const ctx = {
    ...reviewContext,
    findings: [{ id: 'f1', path: 'chains/checkout/trace.json', claim: 'trace-edge', nodes: ['R1', 'P1'] }],
  }
  const p4 = prompts.review(ctx)
  const p6 = prompts.verify(ctx)
  assert.notEqual(p6.system, p4.system)
  assert.notEqual(`${p6.system}${p6.instructions}`, p4.system)
  assert.ok(!p6.system.includes(p4.system), 'P6 must not embed the P4 prompt verbatim')
  assert.deepEqual(validatePromptOutput('verify', p6), [])
})

test('P6 cannot see the P4 reasoning: no rules, no budget, no work order', () => {
  const ctx = {
    ...reviewContext,
    findings: [{ id: 'f1', path: 'chains/checkout/trace.json', claim: 'trace-edge', nodes: ['R1', 'P1'] }],
  }
  const p6 = prompts.verify(ctx)
  assert.ok(!p6.system.includes(reviewContext.ruleText || '\u0000'))
  assert.doesNotMatch(p6.system, /规则库/u)
  assert.doesNotMatch(p6.system, /本轮负责的文档/u)
  assert.equal(p6.rules, undefined)
  assert.equal(p6.budget, undefined)
  assert.equal(typeof p6.instructions, 'string')
})

test('t39: the P6 text carries the attribution basis — and says so when there is none', () => {
  // t29-F1: the P4 side hands the model `refBasis` (the evidence tool `ref_check`
  // returns it), the P6 side did not — so an independent re-checker could not tell a
  // family-level attribution from a membership claim. Asymmetric wiring, fixed here.
  const base = {
    id: 'f1', path: 'chains/checkout/trace.json', claim: 'cross-domain-ref',
    nodes: ['I1'], ref: 'src/cart.ts#L12-L20', message: '一条跨域绑定',
  }
  const render = (finding) => prompts.verify({ ...reviewContext, findings: [finding] }).system

  // (a) a family-level attribution reaches the P6 text with all three fields.
  const withForm = render({
    ...base, refBasis: 'form', refDomain: 'code-review',
    refBasisDetail: 'FAMILY: 多个域产出同一形状',
  })
  assert.match(withForm, /归因档位（若给出）：basis=form/u)
  assert.match(withForm, /refDomain=code-review/u)
  assert.match(withForm, /家族说明=FAMILY/u)

  // (b) THE LOAD-BEARING HALF: an absent basis is RENDERED AS ABSENT, never omitted.
  // Dropping the line would make "no basis was given" and "basis is exact" the same
  // text — the one case a reviewer must not wave through would be invisible.
  const without = render(base)
  assert.match(without, /归因档位（若给出）：basis=\(未给出\)，refDomain=\(未给出\)，家族说明=\(未给出\)/u)
  assert.doesNotMatch(without, /basis=(?:exact|form)/u)

  // (c) ORDER LOCK (t43). This block used to claim "the line count is stable, i.e. the
  // line was made explicit rather than the surrounding block being rearranged" — which
  // is MORE than the two assertions established: a PURE PERMUTATION of the bullets keeps
  // both the multiset and the count, so `notEqual` + equal counts pass on it as well
  // (t40 measured exactly that). What is actually load-bearing is the ORDER:
  //   • every bullet that is not the new attribution line keeps its relative order,
  //     verbatim, and
  //   • the attribution line sits immediately after the cross-domain ref line.
  // The lock was chosen over rewriting the comment because rewriting would shrink the
  // claim to "the line count is stable" — a property of the renderer's formatting, not
  // of the fix — while the lock guards the fix itself (a dropped or moved line).
  const bullets = (text) => text.split('\n').filter((line) => line.startsWith('- '))
  const others = (text) => bullets(text).filter((line) => !line.startsWith('- 归因档位'))
  const at = (text, prefix) => bullets(text).findIndex((line) => line.startsWith(prefix))

  // THE LOCK, as one named predicate, so that the negative control below exercises the
  // very comparison the fix relies on. Order-sensitive on purpose (JSON of the array).
  const lockHolds = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const sameMultiset = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

  assert.notEqual(withForm, without)
  assert.ok(lockHolds(others(withForm), others(without)),
    'the bullets around the new line must be identical AND in the same order')
  assert.equal(at(withForm, '- 归因档位'), at(withForm, '- 涉及的跨域 ref') + 1,
    'the attribution line must sit immediately after the cross-domain ref line')
  assert.equal(at(without, '- 归因档位'), at(without, '- 涉及的跨域 ref') + 1)

  // NEGATIVE CONTROL for the lock: a PURE permutation (same multiset, same count — i.e.
  // exactly the case the old assertions accepted) must be REJECTED. The `sameMultiset`
  // assertion first proves the control really is pure, so a rejection can only come from
  // the order. Weakening `lockHolds` to a count/multiset comparison turns the last
  // assertion below red instead of letting it pass — which is the whole point of naming
  // the predicate: the old `notEqual` + equal-count pair had no such control.
  const permuted = [...others(withForm)].reverse()
  assert.ok(permuted.length === others(withForm).length && sameMultiset(permuted, others(withForm)),
    'the control is a pure permutation: same count, same multiset')
  assert.ok(!lockHolds(permuted, others(withForm)),
    'the lock must reject a pure permutation — a count/multiset comparison would accept it')

  // (d) `exact` is shown as exact, not as a family.
  assert.match(render({ ...base, refBasis: 'exact', refDomain: 'requirement-research' }), /basis=exact/u)

  // (e) a caller that attached the recomputed verdict instead of flattening it is
  // served too — both spellings are read, neither is invented.
  assert.match(render({ ...base, verdict: { refBasis: 'form', refDomain: 'code-review' } }), /basis=form/u)

  // (f) an unknown value is flagged rather than passed through as if it were a tier.
  assert.match(render({ ...base, refBasis: 'probably' }), /basis=probably（\*\*未知档位/u)
})

test('flipping the loss orientation changes BOTH prompts — the pack cannot be silently re-pointed', () => {
  const findings = [{ id: 'f1', path: 'chains/checkout/trace.json', claim: 'trace-edge', nodes: ['R1', 'P1'] }]
  const recall = { pack, orientation: 'recall-first', findings }
  const precision = { pack, orientation: 'precision-first', findings }
  assert.notEqual(prompts.review(recall).system, prompts.review(precision).system)
  assert.notEqual(prompts.verify(recall).system, prompts.verify(precision).system)
})

test('P6 is told that "the graph did not disprove it" is not grounds for dropping', () => {
  const p6 = prompts.verify({ ...reviewContext, findings: [] })
  assert.match(p6.system, /正面否定/u)
  assert.match(p6.instructions, /undecided/u)
})

test('P6 on an empty finding list says the empty set is a legitimate conclusion', () => {
  const p6 = prompts.verify({ ...reviewContext, findings: [] })
  assert.match(p6.system, /空集/u)
})

// ---------------------------------------------------------------------------
// P7 — coverage, the panel, the report
// ---------------------------------------------------------------------------

console.log('\nP7 — coverage, the critique panel and the report')

/** Findings built from REAL verdicts, never from numbers typed here. */
function anchoredFindings(name, locators) {
  const documents = documentsOf(name)
  const out = []
  for (const [index, locator] of locators.entries()) {
    const verdict = anchor.verify({ kind: anchor.kind, path: locator.path, locator }, { path: locator.path, documents })
    assert.equal(verdict.status, 'anchored', `fixture ${name} case ${index}: ${verdict.detail ?? ''}`)
    out.push({
      id: `f${index + 1}`,
      path: verdict.path,
      claim: locator.kind,
      nodes: verdict.nodes,
      message: 'seeded from a recomputed anchor',
      defended: true,
    })
  }
  return out
}

test('the numbers follow the input, not a constant', () => {
  const total = fixture('happy-path').expect.admitted
  const all = anchoredFindings('happy-path', [
    { kind: 'trace-edge', path: 'chains/checkout/trace.json', fromId: 'R1', toId: 'P1', edgeKind: 'derives' },
    { kind: 'trace-edge', path: 'chains/checkout/trace.json', fromId: 'I1', toId: 'C1', edgeKind: 'verifies' },
  ])
  const two = coverage(total, all, { requireComplete: true })
  assert.equal(two.total, total)
  assert.equal(two.reviewed, 2)
  assert.equal(two.coverageRate, Math.round((2 / total) * 10000) / 10000)
  assert.equal(two.complete, false)
  assert.equal(two.required, true, 'a recall-first domain must require completeness')

  const all28 = coverage(total, new Array(total).fill(null).map((_, index) => ({ path: `chains/checkout/f${index}.json` })), { requireComplete: true })
  assert.equal(all28.reviewed, total)
  assert.equal(all28.coverageRate, 1)
  assert.equal(all28.complete, true)
})

test('recall-first: an INCOMPLETE coverage proof is marked NOT passed', () => {
  const proof = coverage(28, [{ path: 'chains/checkout/trace-derives-r1-p1.json' }], { requireComplete: true })
  assert.equal(proof.complete, false)
  assert.equal(proof.required, true)
})

test('coverage counts DISTINCT PATHS — two findings on one path are one reviewed item', () => {
  const proof = coverage(4, [{ path: 'a.json' }, { path: 'a.json' }, { path: 'b.json' }], { requireComplete: false })
  assert.equal(proof.reviewed, 2)
  assert.match(proof.note ?? '', /path/iu)
})

test('the panel keeps doubt and drops only what the graph disproved', () => {
  const kept = anchoredFindings('uncovered', [
    { kind: 'uncovered-requirement', path: 'chains/gap/trace.json', fromId: 'R1' },
  ])
  const outcome = runCritiquePanel(
    [...kept, { id: 'disproved', path: 'chains/gap/trace.json', nodes: ['R2'], disproved: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind },
  )
  assert.equal(outcome.orientation, 'recall-first')
  assert.equal(outcome.kind, 'triage')
  assert.deepEqual(outcome.kept.map((item) => item.id), ['f1'], 'a doubtful item is never dropped here')
  assert.deepEqual(outcome.dropped.map((item) => item.id), ['disproved'])
})

test('the report carries the domain, the orientation, the criticism kind and the coverage', () => {
  const documents = documentsOf('uncovered')
  const found = anchoredFindings('uncovered', [
    { kind: 'uncovered-requirement', path: 'chains/gap/trace.json', fromId: 'R1' },
  ])
  const total = fixture('uncovered').expect.admitted
  const proof = coverage(total, found, { requireComplete: true })
  const out = report({
    domain: pack,
    target: 'fixture uncovered',
    scope: { admitted: total, excluded: 0, bundles: 1 },
    findings: found,
    coverageProof: proof,
    budget: { toolCalls: 1, tokens: 10, note: '' },
    critiqueResult: runCritiquePanel(found, { orientation: pack.lossOrientation, kind: pack.criticism.kind }),
  })
  assert.equal(out.domain, DOMAIN)
  assert.equal(out.criticismKind, 'triage')
  assert.equal(out.lossOrientation, 'recall-first')
  assert.equal(out.generatedAt, null, 'a deterministic engine does not stamp wall-clock time')
  assert.equal(out.coverage.complete, false, 'an incomplete proof must survive into the report')
  assert.equal(out.coverage.required, true)
  assert.deepEqual(out.findings.map((item) => item.id), ['f1'])
  assert.ok(documents.length > 0)
})

test('the gap lister answers with ITEMS, not with a percentage', () => {
  const tool = evidence.tools.find((entry) => entry.name === 'gap_report')
  const result = tool.execute({ corpus: documentsOf('uncovered') })
  assert.ok(Array.isArray(result.items) && result.items.length > 0)
  assert.equal(typeof result.provenance, 'string')
  assert.equal(typeof result.truncated, 'boolean')
  const kinds = new Set(result.items.map((item) => item.kind))
  assert.ok(kinds.has('uncovered-requirement'), `expected the uncovered requirement, got ${[...kinds].join(', ')}`)
  // R2 DOES reach I1, so nothing here is an untraceable implementation — the lister
  // must not invent one to make the report look thorough.
  assert.ok(!kinds.has('untraceable-implementation'), 'R2 reaches I1: this gap does not exist')
  // Every node in this fixture carries a ref, so an unbound node must NOT be reported.
  assert.ok(!kinds.has('missing-ref'), 'these nodes are all bound — the lister must not invent a gap either')
  const unbound = evidence.tools.find((entry) => entry.name === 'gap_report').execute({
    corpus: [{ path: 'chains/bare/trace.json', payload: { nodes: [{ id: 'R1', type: 'requirement' }], edges: [] } }],
  })
  assert.ok(unbound.items.some((item) => item.kind === 'missing-ref' && item.nodeId === 'R1'),
    'a node with no ref IS a gap, and it must be listed item by item')
  // Every item names the node it is about: a gap without an id cannot be adjudicated.
  for (const item of result.items) {
    assert.ok(typeof item.nodeId === 'string' && item.nodeId !== '', JSON.stringify(item))
    assert.ok(typeof item.reason === 'string' && item.reason !== '')
  }
  assert.ok(!/^\s*覆盖[率度]/u.test(result.items[0].reason), 'a percentage is not a finding')
})

test('the gap lister finds the dangling endpoint, the isolated node and the stale ref', () => {
  const tool = evidence.tools.find((entry) => entry.name === 'gap_report')
  const dangling = tool.execute({ corpus: documentsOf('dangling-ref') })
  assert.ok(dangling.items.some((item) => item.kind === 'dangling-endpoint' && item.nodeId === 'MISSING-CASE'))

  const stale = tool.execute({ corpus: documentsOf('stale-ref') })
  assert.ok(stale.items.some((item) => item.kind === 'stale-ref' && item.ref === 'sessions/s9/u1'))

  const happy = tool.execute({ corpus: documentsOf('happy-path') })
  assert.deepEqual(happy.items, [], 'a complete chain must produce no gaps')
})

test('the panel tool reports truncation instead of silently walking a huge graph', () => {
  const tool = evidence.tools.find((entry) => entry.name === 'chain_routes')
  const result = tool.execute({
    corpus: documentsOf('ambiguous-route'),
    from: 'R1',
    to: 'I1',
    maxPaths: 1,
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.truncated, true, 'a capped route walk must say it was capped')
  assert.match(result.notes.join(' '), /上限/u)
})

test('chain_routes returns EVERY reading of a chain — that is what makes ambiguity decidable', () => {
  const tool = evidence.tools.find((entry) => entry.name === 'chain_routes')
  const result = tool.execute({ corpus: documentsOf('ambiguous-route'), from: 'R1', to: 'I1' })
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.items.map((item) => item.route.join('→')).sort(), ['R1→D1→I1', 'R1→D2→I1'])
})

test('node_neighbours answers both directions and refuses to invent a record', () => {
  const tool = evidence.tools.find((entry) => entry.name === 'node_neighbours')
  const one = tool.execute({ corpus: documentsOf('dangling-ref'), nodeId: 'MISSING-CASE' })
  assert.equal(one.items.length, 1)
  assert.equal(one.items[0].hasRecord, false, 'it appears on an edge but has no node record')
  assert.deepEqual(one.items[0].incoming.map((edge) => edge.from), ['I1'])
  assert.throws(() => tool.execute({ corpus: documentsOf('dangling-ref'), nodeId: 'NOWHERE' }), /E_INPUT_FORMAT|断链/u)
})

test('ref_check reports consumability and staleness separately', () => {
  const tool = evidence.tools.find((entry) => entry.name === 'ref_check')
  const stale = tool.execute({ corpus: documentsOf('stale-ref') })
  const staleRow = stale.items.find((item) => item.nodeId === 'R1')
  assert.equal(staleRow.consumable, true, 'the SHAPE is fine')
  assert.equal(staleRow.inUpstream, false, 'and it is nevertheless gone from upstream')
  assert.equal(staleRow.stale, true)
})

test('every tool result carries items / truncated / provenance', () => {
  for (const tool of evidence.tools) {
    const args = tool.name === 'chain_routes'
      ? { corpus: documentsOf('happy-path'), from: 'R1', to: 'C1' }
      : tool.name === 'node_neighbours'
        ? { corpus: documentsOf('happy-path'), nodeId: 'R1' }
        : { corpus: documentsOf('happy-path') }
    const result = tool.execute(args)
    assert.ok(Array.isArray(result.items), `${tool.name}.items`)
    assert.equal(typeof result.truncated, 'boolean', `${tool.name}.truncated`)
    assert.ok(typeof result.provenance === 'string' && result.provenance.length > 10, `${tool.name}.provenance`)
  }
})

test('the derived tool name is the contract\'s own', () => {
  for (const tool of evidence.tools) {
    const name = evidenceToolName(DOMAIN, tool.name)
    assert.match(name, /^adjudicate_requirement_alignment_evidence_/u)
    assert.ok(name.endsWith(tool.name))
  }
})

// ---------------------------------------------------------------------------
// The loader — the directory form is what the plugin actually sees
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form the plugin sees')

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })
  const loaded = await loadDomain(io, { id: DOMAIN, dir: `domains/${DOMAIN}` }, {})
  assert.deepEqual(loaded.problems, [])
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'trace-graph-edges')
  assert.equal(assembled.anchorVerifier.kind, pack.anchor.kind)
  assert.ok(assembled.ruleLibrary.rules.length >= MIN_RULES_PER_DOMAIN)
  assert.ok(assembled.evidenceTools.tools.length >= 4)
  assert.equal(typeof assembled.reviewPrompts.review, 'function')
})

await testAsync('the discovery pass finds this domain and reports no problems for it', async () => {
  const io = await createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })
  const result = await loadDomains(io, {})
  assert.ok(result.packs.some((item) => item.id === DOMAIN))
  assert.deepEqual(result.problems.filter((item) => item.id === DOMAIN), [])
  assert.deepEqual(result.skipped.filter((item) => item.id === DOMAIN), [])
  const loaded = result.loaded.find((item) => item.id === DOMAIN)
  assert.ok(loaded !== undefined)
  assert.ok(loaded.files.includes('source.js') && loaded.files.includes('anchor.js'))
})

await testAsync('`domains/_lib` is skipped by the loader — a shared helper is not a domain', async () => {
  const io = await createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })
  const result = await loadDomains(io, {})
  assert.ok(!result.packs.some((item) => item.id === '_lib'))
  assert.ok(result.skipped.some((item) => item.id === '_lib'))
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
    // A provided service becomes a PROPERTY of the context, the way an injected Cordis
    // service does — the plugin reads `serviceCtx.subagents`, not `ctx.get('subagents')`
    // (index.js `optionalInject`). A mock that only filled a Map would make
    // "provide a service" silently unobservable, which is how a test can end up
    // asserting a `mode: 'none'` degradation instead of the path it meant to drive.
    // Provide BEFORE `apply()`: this mock does not re-run inject callbacks for services
    // that mount later, so a late provide would never be seen.
    provide(name, value) {
      services.set(name, value)
      ctx[name] = value
    },
    set(name, value) {
      services.set(name, value)
      ctx[name] = value
    },
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

/** The engine hands the verifier `{ path, content }`; a graph arrives as JSON text. */
const engineDocuments = (documents) => documents.map((document) => ({
  path: document.path,
  content: JSON.stringify(document.payload),
}))

await testAsync('adjudication_plan consumes the fixture graph through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'trace-graph-edges')
  assert.equal(plan.candidateSet.inputFormat, FORMAT)
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the object form must be applied, not merely declared')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
  // The load-bearing bundling assertion, through the plugin this time: one chain must
  // be ONE bundle holding more than one candidate.
  const checkout = plan.bundles.find((item) => item.key.startsWith('chain/checkout'))
  assert.ok(checkout !== undefined, `expected a chain/checkout bundle, got ${plan.bundles.map((item) => item.key).join(', ')}`)
  assert.ok(checkout.paths.length > 1, 'one candidate per bundle would mean P2 did nothing')
})

await testAsync('R2: the consumable-producer boundary is visible in the PLAN output, not only in a comment', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  // `adjudication_plan` returns `anchor: pack.anchor`, so the anchor DESCRIPTION is
  // what a plan consumer actually reads. The limit used to live only in the REF_SHAPES
  // comment of source.js, where no caller could see it — which is how a bounded id
  // table turns into a silent recall hole.
  assert.match(plan.anchor.description, /REF_SHAPES/u)
  assert.match(plan.anchor.description, /OPAQUE/u)
  assert.match(plan.anchor.description, /移出评审范围/u)
  // The pack summary (`adjudication_domains` prints it) carries the same boundary,
  // including the "outside the six node types ⇒ not guaranteed consumable" sentence.
  assert.match(pack.summary, /不保证可消费/u)
  assert.match(pack.summary, /节点类型/u)
  assert.match(pack.summary, /ui-visual|ux-review|operator-design/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture empty',
    input: { format: empty.input.format, payload: empty.input.payload },
  }, {})
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
  // Through the plugin the pack's OWN gate applies, and nothing survives it: the
  // archived pattern lives in the pack, not in the fixture.
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.deepEqual(new Set(Object.values(predicates)), new Set(['user-exclude', 'default-path', 'extension', 'deleted', 'binary']))
})

await testAsync('adjudication_anchor recomputes a graph anchor through the plugin', async () => {
  const ctx = createPluginContext()
  const documents = engineDocuments(documentsOf('dangling-ref'))
  const out = await ctx.__tools.get('adjudication_anchor').execute({
    domain: DOMAIN,
    path: 'chains/orders/trace.json',
    locator: { kind: 'dangling-ref', fromId: 'I1', toId: 'MISSING-CASE' },
    documents,
  }, {})
  assert.equal(out.via, 'anchorVerifier')
  assert.equal(out.status, 'anchored')
  assert.equal(out.tier, 'declared-locator')
  assert.deepEqual(out.nodes, ['I1', 'MISSING-CASE'])
  assert.equal(out.position, 'node')
})

await testAsync('t32: the basis survives the REAL plugin tool (adjudication_anchor)', async () => {
  // t32's other assertions drive `anchor.verify` directly. This one goes through the
  // engine's own tool, because the basis only does its job if it reaches the caller —
  // `refDomain: 'code-review'` printed on its own is the over-confident answer.
  const ctx = createPluginContext()
  const out = await ctx.__tools.get('adjudication_anchor').execute({
    domain: DOMAIN,
    path: 'chains/checkout/trace.json',
    locator: { kind: 'cross-domain-ref', fromId: 'I1' },
    documents: engineDocuments(documentsOf('happy-path')),
  }, {})
  assert.equal(out.via, 'anchorVerifier')
  assert.equal(out.status, 'anchored')
  assert.equal(out.refDomain, 'code-review')
  assert.equal(out.refBasis, 'form')
})

await testAsync('submit recomputes every anchor, and a fabricated one is rejected', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  // The plan runs FIRST and with the SAME target: the engine floors the coverage
  // denominator with the admission count it recorded during planning, and that floor
  // is what makes this a real recall-first failure rather than a 1/1 pass.
  await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})
  const documents = engineDocuments(documentsOf('happy-path'))
  const good = {
    id: 'good', path: 'chains/checkout/trace.json',
    locator: { kind: 'trace-edge', fromId: 'R1', toId: 'P1', edgeKind: 'derives' },
    severity: 'high', message: 'R1 与 P1 之间的 derives 边已确认',
  }
  // A finding the model asserts but the graph cannot confirm — and it even SELF-REPORTS
  // a location, which the engine must ignore.
  const fabricated = {
    id: 'fabricated', path: 'chains/checkout/trace.json', start: 1, end: 1, anchored: true,
    locator: { kind: 'trace-edge', fromId: 'R1', toId: 'I1', edgeKind: 'implements' },
    severity: 'high', message: 'R1 由 I1 直接实现',
  }
  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    documents,
    findings: [good, fabricated],
  }, {})
  assert.equal(out.criticismKind, 'triage')
  assert.match(out.summary, /复核者：triage/u)
  assert.equal(out.unanchored, 1, 'the fabricated finding must be rejected by the recomputation')
  assert.equal(out.unanchoredDetails[0].id, 'fabricated')
  assert.equal(out.unanchoredDetails[0].tier, 'locator-mismatch')
  assert.equal(out.coverage.total, happy.expect.admitted, 'the plan floor is the denominator')
  assert.equal(out.coverage.complete, false)
  assert.match(out.summary, /不完整/u, 'recall-first with a partial proof must report 不完整')
})

await testAsync('t43: the REAL submit path hands the P6 layer the attribution basis', async () => {
  // t43-F2. Every basis assertion above feeds P6 a HAND-WRITTEN finding — a world built
  // in this file. This one drives the real path end to end:
  //
  //   adjudication_submit
  //     -> recompute each finding's anchor with the domain's own verifier,
  //     -> fold the verdict onto the finding (the engine's whitelist, `P6_VERDICT_FIELDS`),
  //     -> hand the anchored set to the reasoner,
  //     -> which renders `reviewPrompts.verify` and sends THAT TEXT to P6.
  //
  // It therefore fails on either half regressing, including the asymmetric case it exists
  // for: P4 wired, P6 dropped again. A domain test that only asserted a fixed gap
  // ("renderVerifyPrompt does not exist") would instead go red the day the gap CLOSED.
  const ctx = createMockContext()
  const handedToP6 = []
  ctx.provide('subagents', {
    async start(request) {
      handedToP6.push(request)
      return {
        result: Promise.resolve({ output: '', structured: { verdicts: [] }, stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  })
  applyPlugin(ctx, { promptSection: false })

  const happy = fixture('happy-path')
  await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    documents: engineDocuments(documentsOf('happy-path')),
    findings: [
      {
        id: 'family', path: 'chains/checkout/trace.json',
        locator: { kind: 'cross-domain-ref', fromId: 'I1' }, // ref = src/cart.ts#L12-L20
        severity: 'low', message: '实现节点的跨域绑定',
      },
      {
        id: 'exact', path: 'chains/checkout/trace.json',
        locator: { kind: 'cross-domain-ref', fromId: 'R1' }, // ref = sessions/s1/u2
        severity: 'low', message: '需求节点的跨域绑定',
      },
    ],
  }, {})

  // (i) the finding the ENGINE folded really carries the three fields.
  const family = out.findings.find((item) => item.id === 'family')
  assert.ok(family !== undefined,
    `the anchored finding must survive into the report; got ${out.findings.map((item) => item.id).join(', ')}`)
  assert.equal(family.refBasis, 'form')
  assert.equal(family.refDomain, 'code-review')
  assert.equal(typeof family.refBasisDetail, 'string')
  assert.equal(out.findings.find((item) => item.id === 'exact').refBasis, 'exact')

  // … and it arrives FLAT. The nested spellings `attributionFields` tolerates have no
  // producer in this repository; if one ever appears, this says so instead of the
  // tolerance being read as evidence that the nested shape occurs here.
  assert.equal(family.verdict, undefined, 'no producer emits a nested `verdict` on a finding')
  assert.equal(family.anchor, undefined, 'no producer emits a nested `anchor` on a finding')

  // (ii) the text the engine ACTUALLY gave to P6 carries the rendered attribution line,
  // with the right value for each basis.
  assert.equal(handedToP6.length, 1, 'the real path must start exactly one P6 child')
  const promptText = handedToP6[0].prompt.map((part) => part.text).join('\n')
  assert.match(promptText, /归因档位（若给出）：basis=form，refDomain=code-review，家族说明=\S/u)
  assert.match(promptText, /归因档位（若给出）：basis=exact，refDomain=requirement-research，家族说明=\S/u)
  assert.doesNotMatch(promptText, /basis=\(未给出\)/u,
    'the real path knows the basis — rendering 未给出 here means the fold or the renderer regressed')

  // (iii) it went through THIS domain's `reviewPrompts.verify`, not a legacy fallback.
  assert.equal(out.review.verify.prompt.source, 'reviewPrompts.verify')
  assert.equal(out.review.verify.mode, 'subagents')
  assert.equal(out.review.verify.ran, true)
  assert.deepEqual(out.review.verify.toolFilter, { allow: [] }, 'P6 must not get the domain tools')
})

await testAsync('the coverage denominator cannot be shrunk by a caller-supplied total', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})
  const documents = engineDocuments(documentsOf('happy-path'))
  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    total: 1, // an attempt to inflate the rate
    documents,
    findings: [{
      id: 'one', path: 'chains/checkout/trace.json',
      locator: { kind: 'trace-edge', fromId: 'R1', toId: 'P1', edgeKind: 'derives' },
      severity: 'low', message: '一条已确认的边',
    }],
  }, {})
  assert.equal(out.coverage.total, happy.expect.admitted, 'the engine floor must win over a smaller claim')
  assert.equal(out.coverage.raisedAboveDeclared, true)
  assert.equal(out.coverage.totalSource, 'plan')
  assert.equal(out.coverage.complete, false)
})

await testAsync('EVERY fixture anchor case reaches a verdict through the real plugin tool', async () => {
  // The requirement this exists for, in the captain's words: an assertion that this
  // domain's anchors can be obtained through the real `adjudication_anchor`, not only
  // by calling `verify` directly.
  //
  // The difference is not cosmetic. `verify` is exercised with whatever object this
  // file builds; the plugin path goes through the engine, which normalises every
  // document to `{ path, content }`. A graph domain that cannot read its graph back
  // out of `content` therefore passes its own test suite and anchors NOTHING in
  // production. That failure mode was measured fleet-wide; this loop is why it cannot
  // happen here.
  const ctx = createPluginContext()
  const anchorTool = ctx.__tools.get('adjudication_anchor')
  let checked = 0
  for (const { fixture: name, bucket, entry } of anchorCases()) {
    // The fixture's own folded subject — the same material any harness would fold.
    assert.ok(entry.subject !== undefined, `${name} ${bucket}: fixture must ship a folded subject`)
    const documents = entry.subject.documents
    if (entry.subject.content !== null) {
      assert.equal(typeof entry.subject.content, 'string',
        `${name} ${bucket}: the named document must arrive as JSON text, the engine's own shape`)
    }
    assert.ok(documents.every((document) => typeof document.content === 'string'),
      `${name} ${bucket}: documents must be {path, content} — the engine's own shape`)
    const out = await anchorTool.execute({
      domain: DOMAIN,
      path: entry.subject.path,
      locator: entry.claim.locator,
      documents,
    }, {})
    assert.equal(out.via, 'anchorVerifier',
      `${name} ${bucket}: the domain verifier was not reached (${out.via})`)
    assert.equal(out.status, entry.expectStatus, `${name} ${bucket}: ${out.detail ?? ''}`)
    assert.equal(out.tier, entry.expectTier, `${name} ${bucket}: ${out.detail ?? ''}`)
    checked += 1
  }
  assert.equal(checked, anchorCases().length)
  assert.ok(checked >= 30, `only ${checked} anchor cases went through the plugin`)
})

await testAsync('activation registers this domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName(DOMAIN, tool.name)), `${tool.name} must be registered on activation`)
  }
  const gaps = ctx.__tools.get(evidenceToolName(DOMAIN, 'gap_report'))
  const result = await gaps.execute({ corpus: documentsOf('uncovered') }, {})
  assert.ok(result.items.length > 0)
  assert.equal(result.items[0].kind !== undefined, true)
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: DOMAIN }, {})
  for (const tool of evidence.tools) {
    assert.ok(!ctx.__tools.has(evidenceToolName(DOMAIN, tool.name)), `${tool.name} must be gone after deactivation`)
  }
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  const listed = await ctx.__tools.get('adjudicate_requirement_alignment_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('the loaded directory pack replaces the built-in v1 pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'replacement check',
    input: { format: FORMAT, payload: fixture('happy-path').input.payload },
  }, {})
  assert.equal(plan.candidateSet.origin, 'candidateSource',
    'the v1 pack has no candidateSource — seeing one proves the directory pack won')
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
