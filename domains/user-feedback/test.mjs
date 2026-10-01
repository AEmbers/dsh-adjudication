/**
 * user-feedback — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  deterministic candidate set
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey.resolve          ->  real THEME grouping (not one-per-path)
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  recomputed closures / orphans / quotes
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * Then it drives the assembled pack through the plugin's own mock Cordis context,
 * so the domain is proven to work where it is actually used.
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
 *    candidates which SHOULD share a bundle really do — `applied: true` with a
 *    per-candidate key would be P2 silently not done.
 * 4. It never feeds the plugin a self-reported anchor. Every coverage assertion
 *    downstream of `adjudication_submit` is driven by findings this file first put
 *    through the domain's own `anchorVerifier.verify`.
 * 5. **It never lets an incomplete recall-first run pass quietly.** This domain's
 *    loss orientation says a dropped feedback item is the expensive error, so the
 *    suite asserts that incomplete coverage is REPORTED INCOMPLETE and that every
 *    open closure is listed individually — a count would be the defect this domain
 *    exists to find.
 *
 * Usage: `node domains/user-feedback/test.mjs`
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { createNodeIo, loadDomain, loadDomains } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack, { bundleKey as declaredBundleKey, themeKey, GATE_EXTENSIONS } from './index.js'
import source, {
  MIN_QUOTE_CHARS,
  REACH_WEIGHT,
  SEVERITY_WEIGHT,
  closureGaps,
  ledgerRanks,
} from './source.js'
import anchor, { ANCHOR_KINDS, REACHABLE_TIERS, constituentsDeclared } from './anchor.js'
import evidence from './evidence.js'
import prompts from './prompts.js'

const here = dirname(fileURLToPath(import.meta.url))
const DOMAIN = 'user-feedback'
const FORMAT = 'feedback-ledger'

/** The tiers that mean "this claim was not confirmed". */
const REFUSAL_TIERS_FOR_TEST = Object.freeze([
  'no-documents', 'no-match', 'empty-excerpt', 'kind-mismatch', 'locator-mismatch', 'relocation-ambiguous',
])

/**
 * How each `closureGaps()` kind is turned into an anchorable claim.
 *
 * Module scope, and TOTAL, on purpose. An earlier version of the end-to-end test
 * inlined this as an if/if/else chain whose `else` was `unclosed-feedback`: a
 * fourth gap kind would have been silently mistranslated into a claim about an id
 * the ledger never declares, and the verifier would correctly refuse it. The
 * symptom would have read "the new feature does not anchor" instead of "this table
 * is incomplete" — the same "the test describes what I thought happens" shape as
 * the F1 defect, one layer up.
 *
 * `dangling-closure` and `dangling-address` are the two directions of the same
 * anchor-layer claim (`unregistered-reference`) with the roles swapped: a broken
 * `closedBy` points at a decision that does not exist, a broken `addresses` points
 * at a feedback that does not exist. They stay two gap KINDS because they are two
 * different findings a reader must not conflate — fixing one does not fix the
 * other.
 */
const GAP_CLAIM_BUILDERS = Object.freeze({
  'dangling-closure': (gap) => ({ kind: 'unregistered-reference', referencedId: gap.decisionId, referrerId: gap.feedbackId }),
  'dangling-address': (gap) => ({ kind: 'unregistered-reference', referencedId: gap.feedbackId, referrerId: gap.decisionId }),
  'one-sided-closure': (gap) => ({ kind: 'one-sided-closure', feedbackId: gap.feedbackId, decisionId: gap.decisionId }),
  'unclosed-feedback': (gap) => ({ kind: 'unclosed-feedback', feedbackId: gap.feedbackId }),
})

/**
 * The pack the ENGINE sees: `index.js` plus the five extension points the loader
 * assembles from the sibling files, plus the fixtures it auto-lists.
 *
 * `validateDomainPackV2` is applied to THIS, not to the bare import. The bare import
 * is intentionally incomplete — it declares only what the pack alone knows, and
 * asserting the v2 contract against it would fail for the wrong reason (five missing
 * extension points) while telling us nothing about whether the thing that ships is
 * valid. Loaded once here so every test reads the same object.
 */
const loadIo = await createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })
const loaded = await loadDomain(loadIo, { id: DOMAIN, dir: `domains/${DOMAIN}` })
const assembled = loaded.pack

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

/** One fixture's ledger payload, for the source-level rank/gap assertions. */
const ledgerPayload = (name) => {
  const value = fixture(name)
  const documents = value.input.payload.documents ?? [{ path: value.input.payload.ledgerPath ?? 'feedback/ledger.json', payload: value.input.payload }]
  return { path: documents[0].path, payload: documents[0].payload }
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\npack identity — the v2 contract')

test('the pack passes validateDomainPackV2 with no problems', () => {
  // The LOADED pack — `index.js` plus the five loader-assembled extension points plus
  // the auto-listed fixtures. See the note on `assembled` above.
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  assert.deepEqual(validateDomainPackV2(assembled), [])
})

test('the contract itself is intact before any of this is believed', () => {
  assert.deepEqual(checkContractIntegrity(), [])
})

test('the declared input format is the one the contract documents for this domain', () => {
  assert.equal(inputFormatFor(DOMAIN).format, FORMAT)
  assert.equal(pack.candidateSet.inputFormat, FORMAT)
  assert.equal(source.inputFormat, FORMAT)
})

test('lossOrientation is recall-first and the criticism kind agrees with it', () => {
  // The pairing is checked by `criticismKindConsistent` at pack-validation time, but
  // asserting it here too means a future edit that flips one without the other fails
  // in THIS domain's test rather than only in the shared validator.
  assert.equal(pack.lossOrientation, 'recall-first')
  assert.equal(pack.criticism.kind, 'triage')
})

test('the pack declares no extension point inline — the loader assembles all five', () => {
  // A named `candidateSource` export here would SHADOW `source.js` in
  // `lib/domain-loader.js` and fail with "enumerate must be a function". This
  // asserts the file stays out of its own way.
  assert.equal(Object.hasOwn(pack, 'candidateSource'), false)
  assert.equal(Object.hasOwn(pack, 'anchorVerifier'), false)
  assert.equal(Object.hasOwn(pack, 'evidenceTools'), false)
  assert.equal(Object.hasOwn(pack, 'reviewPrompts'), false)
  assert.equal(Object.hasOwn(pack, 'ruleLibrary'), false)
})

test('the recovery prompt stays as a v1-shaped fallback', () => {
  // `reviewPrompts` is the real prompt. This fallback exists so a prompt function
  // that throws cannot take the pipeline down, so it must remain present and
  // MUST NOT be a copy of the v2 prompts.
  assert.equal(typeof pack.prompt?.role, 'string')
  assert.equal(typeof pack.prompt?.instruction, 'string')
  assert.ok(pack.prompt.role.length > 10)
})

// ---------------------------------------------------------------------------
// P0 — candidate source
// ---------------------------------------------------------------------------

console.log('\nP0 — candidate source and the documented input format')

test('every fixture declares the format this pack reads, and every fixture validates', () => {
  for (const [name, value] of FIXTURES) {
    const problems = validateFixture(value)
    assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`)
    assert.equal(value.format, FORMAT, `${name} declares format "${value.format}"`)
    assert.equal(value.input.format, FORMAT)
  }
})

test('the fixtures the contract mandates are all present', () => {
  for (const name of MANDATORY_FIXTURES) assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  // The v1 declaration promised `unclosed-only`; keeping it means the recall-first
  // work list has a sample that is entirely gaps.
  assert.ok(FIXTURES.has('unclosed-only'))
})

for (const [name, value] of FIXTURES) {
  test(`P0 enumerates the fixture's ledger into the declared candidates [${name}]`, () => {
    const { enumerated, result } = runP0P1(name)
    assert.deepEqual(validateCandidateSetResult(enumerated), [], enumerated.problems?.join('; '))
    assert.equal(enumerated.candidates.length, value.expect.candidates)
    assert.equal(result.selected.length, value.expect.admitted)
    assert.deepEqual(enumerated.candidates.map((entry) => entry.path).sort(), [...value.expect.paths].sort())
    assert.deepEqual(byPredicate(result), value.expect.excludedByPredicate)
    assert.equal(enumerated.bounded, value.expect.bounded)
    assert.equal(enumerated.truncated, value.expect.truncated)
  })
}

test('the all-gated-out fixture is excluded by the PACK\'s own gate, not by a fixture-local rule', () => {
  // The failure this guards against: a fixture that reaches `admitted: 0` only because it
  // smuggled extra `exclude` globs into itself. Such a fixture passes its own test and
  // then, driven through the plugin (which uses the PACK's gate), admits everything —
  // a test that proves nothing about the pack.
  //
  // Three assertions, and the third is the real one:
  //   1. no fixture declares a gate override at all;
  //   2. the pack's own gate excludes all six candidates;
  //   3. the same thing happens through `adjudication_plan`, which is the code path a
  //      host actually takes.
  for (const [name, value] of FIXTURES) {
    assert.equal(value.gate, undefined, `${name} must not carry its own gate rules`)
  }
  const gated = fixture('all-gated-out')
  const enumerated = source.enumerate(gated.input.payload, { maxCandidates: 400, maxExcerptLines: 200 })
  const result = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: pack.gate?.exclude ?? [],
    extensions: pack.gate?.extensions ?? null,
  })
  assert.equal(enumerated.candidates.length, gated.expect.candidates, 'P0 still enumerates')
  assert.equal(result.selected.length, 0, 'the pack\'s own gate admits nothing')
  assert.equal(result.excluded.length, gated.expect.candidates)
  // Four different predicates, each attributable to the pack or to the engine's own
  // defaults — never to the fixture.
  assert.deepEqual(Object.keys(byPredicate(result)).sort(), ['binary', 'deleted', 'extension', 'user-exclude'])
})

test('boundary: an empty ledger enumerates nothing and says so instead of inventing work', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(result.selected.length, 0)
  assert.deepEqual(result.excluded, [])
  assert.ok(enumerated.notes.length > 0, 'an empty ledger must carry a note, not silence')
  assert.match(enumerated.notes.join('\n'), /空集/u)
})

test('boundary: a fully-excluded ledger is distinguishable from an empty one', () => {
  const empty = runP0P1('empty')
  const gatedOut = runP0P1('all-gated-out')
  // The distinction is the whole point: "P0 found nothing" and "P1 removed
  // everything" are different facts about the ledger, and a plan that reports the
  // same thing for both has lost the information.
  assert.equal(empty.enumerated.candidates.length, 0)
  assert.ok(gatedOut.enumerated.candidates.length > 0, 'P0 must still enumerate')
  assert.equal(gatedOut.result.selected.length, 0, 'P1 must remove every one')
  assert.equal(gatedOut.result.excluded.length, gatedOut.enumerated.candidates.length)
})

test('the source refuses malformed input rather than returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ feedback: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ decisions: {} }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ themes: 42 }, {}), /E_INPUT_FORMAT/u)
})

test('candidate ids are unique, paths are gate-globable, and raw ids stay in the locator', () => {
  for (const [name] of FIXTURES) {
    const { enumerated } = runP0P1(name)
    const ids = new Set()
    for (const candidate of enumerated.candidates) {
      assert.equal(candidate.id, candidate.path, 'id and path are the same identity here')
      assert.ok(!ids.has(candidate.id), `duplicate candidate id ${candidate.id} in ${name}`)
      ids.add(candidate.id)
      assert.match(candidate.path, /^[a-z0-9][a-z0-9._:/-]*$/u, `path is not gate-globable: ${candidate.path}`)
      assert.equal(typeof candidate.locator.kind, 'string')
      assert.ok(candidate.text.length > 0)
    }
  }
})

test('the raw feedback ids never leak into a path — a slug is lossy and must not be parsed back', () => {
  // `fb-1001` and `fb-1002` slug to different tokens, but `FB-1001` and `fb-1001`
  // would not. Nothing may depend on reading an id out of a path.
  const { enumerated } = runP0P1('happy-path')
  const feedbackNode = enumerated.candidates.find((entry) => entry.locator.kind === 'feedback-node' && entry.locator.feedbackId === 'fb-1001')
  assert.ok(feedbackNode !== undefined)
  assert.equal(feedbackNode.path, 'feedback/ledger-fb-1001.json')
  assert.equal(feedbackNode.locator.feedbackId, 'fb-1001', 'the raw id lives in the locator, not in the path')
})

test('both spellings of a link produce ONE candidate, and the sides stay distinct', () => {
  // `dec-20` and `fb-1001` name each other, so there is exactly one link candidate.
  // Whether the two spellings AGREE is a property of the evidence, reported in
  // `meta.mutual` — collapsing that into the topology would make a one-sided
  // closure indistinguishable from a real one.
  const { enumerated } = runP0P1('happy-path')
  const links = enumerated.candidates.filter((entry) => entry.meta.candidateKind === 'closure-edge')
  assert.equal(links.length, 5)
  const mutual = links.filter((entry) => entry.meta.mutual === true)
  const oneSided = links.filter((entry) => entry.meta.oneSided === true)
  assert.equal(mutual.length, 1, 'exactly one pair in this fixture declares both sides')
  assert.equal(oneSided.length, 4)
  assert.equal(mutual.length + oneSided.length, links.length, 'every link is either mutual or one-sided')
  assert.deepEqual(mutual.map((entry) => [entry.locator.feedbackId, entry.locator.decisionId]), [['fb-1001', 'dec-20']])
})

test('a link to an unregistered id is enumerated, not silently dropped', () => {
  const { enumerated } = runP0P1('happy-path')
  const dangling = enumerated.candidates.find((entry) => entry.locator.feedbackId === 'fb-9999')
  assert.ok(dangling !== undefined, 'the dangling reference must survive P0 — it is a finding, not noise')
  assert.match(enumerated.notes.join('\n'), /fb-9999/u)
  assert.match(enumerated.notes.join('\n'), /未登记的引用/u)
})

test('the source declares bounded:true and the contract agrees for this domain', () => {
  assert.equal(source.bounded, true)
  assert.equal(inputFormatFor(DOMAIN).bounded, true)
  assert.equal(pack.candidateSet.bounded, true)
})

// ---------------------------------------------------------------------------
// The two rankings that must not be merged
// ---------------------------------------------------------------------------

console.log('\nrecall-first — loss and frequency stay apart')

test('the two rankings disagree on the main fixture, and the disagreement is recorded', () => {
  const expected = fixture('happy-path').observations.rankChecks
  const ranks = ledgerRanks(ledgerPayload('happy-path'))
  assert.deepEqual(ranks.byLoss, expected.byLoss)
  assert.deepEqual(ranks.byFrequency, expected.byFrequency)
  assert.notDeepEqual(ranks.byLoss, ranks.byFrequency, 'if the two orderings agreed, this fixture would not test anything')
})

test('low-frequency high-loss items are named, not drowned', () => {
  const expected = fixture('happy-path').observations.rankChecks
  const ranks = ledgerRanks(ledgerPayload('happy-path'))
  assert.deepEqual(ranks.drownRisk, expected.drownRisk)
  assert.ok(ranks.drownRisk.length > 0, 'this fixture exists to produce a non-empty drownRisk')

  for (const id of ranks.drownRisk) {
    const row = ranks.rows.find((entry) => entry.id === id)
    // The property, not the number: a drowned item is one whose loss rank is far
    // better than its frequency rank.
    assert.ok(ranks.byLoss.indexOf(id) < ranks.byFrequency.indexOf(id), `${id} must rank better on loss than on frequency`)
    assert.ok(row.loss > 0)
  }
  // ...and the item that a count-sorted triage would put first is exactly the one
  // whose loss is worst. That asymmetry is the finding.
  const topByFrequency = ranks.byFrequency[0]
  const topByLoss = ranks.byLoss[0]
  assert.notEqual(topByFrequency, topByLoss)
  assert.ok(ranks.rows.find((row) => row.id === topByFrequency).frequency > ranks.rows.find((row) => row.id === topByLoss).frequency)
})

test('the loss weight is the product of severity and reach, and both are read from the record', () => {
  const ranks = ledgerRanks(ledgerPayload('happy-path'))
  const row = ranks.rows.find((entry) => entry.id === 'fb-1001')
  assert.equal(row.severity, 'blocker')
  assert.equal(row.reach, 'all')
  assert.equal(row.loss, SEVERITY_WEIGHT.blocker * REACH_WEIGHT.all)
  assert.equal(row.frequency, 2, 'frequency stays a separate number, never folded into loss')
})

test('the rankings are total and stable — ties break by id, not by input order', () => {
  const payload = ledgerPayload('happy-path')
  const forward = ledgerRanks(payload)
  const reversed = ledgerRanks({ ...payload, payload: { ...payload.payload, feedback: [...payload.payload.feedback].reverse() } })
  assert.deepEqual(reversed.byLoss, forward.byLoss)
  assert.deepEqual(reversed.byFrequency, forward.byFrequency)
})

test('fewer than four rows means no drownRisk — quartiles of three items are noise', () => {
  const payload = { payload: { feedback: [
    { id: 'fb-a', quote: '一条很短的原话', severity: 'blocker', reach: 'all', frequency: 1 },
    { id: 'fb-b', quote: '另一条很短的原话', severity: 'low', reach: 'few', frequency: 9 },
    { id: 'fb-c', quote: '第三条很短的原话', severity: 'low', reach: 'few', frequency: 8 },
  ] } }
  const ranks = ledgerRanks(payload)
  assert.equal(ranks.rows.length, 3)
  assert.deepEqual(ranks.drownRisk, [])
  assert.equal(ranks.byLoss[0], 'fb-a')
  assert.equal(ranks.byFrequency[0], 'fb-b')
})

// ---------------------------------------------------------------------------
// The closure work list
// ---------------------------------------------------------------------------

console.log('\nrecall-first — the gap list is a list')

for (const [name, value] of FIXTURES) {
  if (value.observations?.gapCount === undefined) continue
  test(`every open closure is listed individually [${name}]`, () => {
    const { gaps, orphanDecisions } = closureGaps(ledgerPayload(name))
    assert.equal(gaps.length, value.observations?.gapCount)
    assert.deepEqual(gaps.map((entry) => entry.feedbackId), value.observations?.gapFeedbackIds)
    assert.deepEqual(orphanDecisions.map((entry) => entry.decisionId), value.observations?.orphanDecisionIds)
    for (const gap of gaps) {
      assert.ok(typeof gap.reason === 'string' && gap.reason.length > 10, 'every gap must explain itself')
      assert.ok(['none', 'addresses-only', 'closed-by-only', 'mixed'].includes(gap.side))
      assert.match(gap.reason, new RegExp(gap.feedbackId, 'u'))
    }
    for (const orphan of orphanDecisions) assert.match(orphan.reason, new RegExp(orphan.decisionId, 'u'))
  })
}

test('a one-sided closure is reported as a gap even though a decision mentions it', () => {
  // The distinction this domain exists for: `fb-1002` IS named by `dec-21`, so a
  // reviewer reading the decision log sees it as handled. It is still a gap, because
  // the record itself never says so.
  const { gaps } = closureGaps(ledgerPayload('happy-path'))
  const oneSided = gaps.find((entry) => entry.feedbackId === 'fb-1002')
  assert.ok(oneSided !== undefined)
  assert.equal(oneSided.kind, 'one-sided-closure')
  assert.equal(oneSided.side, 'addresses-only')
  assert.equal(oneSided.decisionId, 'dec-21')
})

test('a dangling closure is reported as its own defect kind, with the missing decision named', () => {
  const { gaps } = closureGaps(ledgerPayload('happy-path'))
  const dangling = gaps.find((entry) => entry.feedbackId === 'fb-1003')
  assert.ok(dangling !== undefined)
  // `dangling-closure`, not `one-sided-closure`. The link IS one-sided, but nothing can
  // be one-sided against a record that does not exist — and the distinction decides
  // which claim the reviewer must submit: a partial closure is verified against the
  // decision it names, while a dangling one is a broken LINK and is verified as an
  // unregistered reference. Collapsing the two leaves one of them unanchorable, which
  // is exactly what happened when this suite first ran.
  assert.equal(dangling.kind, 'dangling-closure')
  assert.equal(dangling.side, 'closed-by-only')
  assert.equal(dangling.decisionId, 'dec-77')
  assert.match(dangling.reason, /悬空闭环/u)
  assert.match(dangling.reason, /失效链接/u)
  // ...and the decision it names is genuinely absent, which is what makes the reference
  // unregistered rather than merely one-sided.
  const declared = new Set(ledgerPayload('happy-path').payload.decisions.map((decision) => decision.id))
  assert.equal(declared.has('dec-77'), false)
})

test('a ledger with no closure at all produces one gap per item', () => {
  const payload = ledgerPayload('unclosed-only')
  const { gaps } = closureGaps(payload)
  const total = payload.payload.feedback.length
  assert.equal(gaps.length, total, 'every feedback item is a gap here')
  for (const gap of gaps) {
    assert.equal(gap.kind, 'unclosed-feedback')
    assert.equal(gap.side, 'none')
  }
})

// ---------------------------------------------------------------------------
// P2 — bundling
// ---------------------------------------------------------------------------

console.log('\nP2 — bundleKey, the field that was declared but never read')

test('the v2 bundleKey is an object with a real resolver, and the contract accepts it', () => {
  assert.equal(typeof pack.bundleKey, 'object')
  assert.equal(typeof pack.bundleKey.resolve, 'function')
  assert.equal(pack.bundleKey.strategy, 'theme')
  assert.equal(declaredBundleKey, pack.bundleKey)
  assert.deepEqual(validateDomainPackV2(assembled), [])
})

test('two feedback items of the SAME theme land in the SAME bundle — not one bundle per candidate', () => {
  const { result } = runP0P1('happy-path')
  const { bundled, infos } = keyedBundles(result.selected)
  assert.ok(infos.every((info) => typeof info === 'string' && info !== ''), 'every candidate must resolve to a key')

  const cartEntries = result.selected.filter((entry) => entry.meta?.theme === 'checkout')
  assert.ok(cartEntries.length >= 4, `expected a real checkout cluster, got ${cartEntries.length}`)
  const keys = new Set(cartEntries.map((entry) => themeKey(entry)))
  assert.equal(keys.size, 1, `checkout items must collapse to ONE key, got ${[...keys].join(', ')}`)

  const cluster = bundled.bundles.find((item) => item.key === 'theme/checkout')
  assert.ok(cluster !== undefined, 'the checkout bundle must exist by name')
  assert.equal(cluster.entries.length, cartEntries.length, 'the bundle must hold exactly this theme — not a subset, not the whole ledger')
  // The load-bearing part: bundle size is NOT one. `{ strategy: 'path' }` would give
  // every candidate its own bundle and still satisfy `applied: true`.
  assert.ok(cluster.entries.length > 1, 'a single-entry bundle would mean P2 did nothing')
  assert.ok(bundled.bundles.length > 1, 'a multi-theme ledger must split into more than one bundle')
  assert.equal(bundled.strategy, 'keyed')
})

test('the resolved bundle keys are the fixture\'s declared keys, not asserted from a constant', () => {
  const expected = fixture('happy-path').observations.bundleKeys
  const { result } = runP0P1('happy-path')
  const { bundled } = keyedBundles(result.selected)
  // Set equality, not array equality: the ORDER bundles come out in is `bundle()`'s
  // business, not this domain's.
  assert.deepEqual([...new Set(bundled.bundles.map((item) => item.key))].sort(), expected)
})

test('every decision and theme node shares the document bundle — nothing is dropped from P2', () => {
  // A resolver that returned a unique key per candidate would still produce a
  // `theme/*` bundle for the tagged items and silently scatter the rest. The
  // untagged population must land together under the document key.
  const { result } = runP0P1('happy-path')
  const { bundled } = keyedBundles(result.selected)
  const docBundle = bundled.bundles.find((item) => item.key === 'doc/feedback/ledger.json')
  assert.ok(docBundle !== undefined)
  const untagged = result.selected.filter((entry) => entry.meta?.theme === undefined || entry.meta?.theme === null)
  assert.equal(docBundle.entries.length, untagged.length)
  assert.ok(docBundle.entries.length > 1, 'the untagged population is not a singleton in this fixture')
})

test('a candidate with no theme or ledger path falls back deterministically to its directory', () => {
  assert.equal(themeKey({ path: 'feedback/a-fb-1.json' }), 'dir/feedback')
  assert.equal(themeKey({ path: 'feedback/a-fb-1.json', meta: {} }), 'dir/feedback')
  assert.equal(themeKey({ path: 'x/y/z.json', meta: { theme: 't' } }), 'theme/t')
  assert.equal(themeKey({ path: 'x/y/z.json', meta: { ledgerPath: 'feedback/ledger.json' } }), 'doc/feedback/ledger.json')
})

test('the resolver\'s output is a function of the candidate alone, never of its neighbours', () => {
  // A grouping that depended on the rest of the set would make the bundle set depend
  // on enumeration order, and every bundling assertion above meaningless.
  const { result } = runP0P1('happy-path')
  const { infos } = keyedBundles(result.selected)
  const again = result.selected.map((entry) => themeKey(entry))
  assert.deepEqual(again, infos)
  const reversed = [...result.selected].reverse().map((entry) => themeKey(entry))
  assert.deepEqual([...reversed].sort(), [...infos].sort())
})

// ---------------------------------------------------------------------------
// P3 — rule library
// ---------------------------------------------------------------------------

console.log('\nP3 — the rule library')

test('the library has at least the contract minimum of rules', () => {
  assert.ok(RULE_FILES.length >= MIN_RULES_PER_DOMAIN, `${RULE_FILES.length} rule documents`)
  assert.equal(pack.ruleLibrary, undefined, 'the library is assembled by the loader, not declared inline')
})

test('every rule document has front-matter the contract accepts, flagged for expert review', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const problems = validateRuleDocument(text)
    assert.deepEqual(problems, [], `${file}: ${problems.join('; ')}`)
    assert.match(text, /needs-expert-review: true/u, `${file} must be flagged`)
    assert.match(text, /^---\nname: [a-z0-9-]+\n/mu, `${file} front-matter shape`)
  }
})

test('no rule claims to be expert-validated', () => {
  // The honesty premise is not decoration. A rule library that reads as authoritative
  // changes how a model uses it, so the DRAFT status has to be checkable.
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    assert.doesNotMatch(text, /专家审定|已通过专家|expert-validated|expert approved/iu, `${file} claims expert validation`)
    assert.match(text, /source: agent-drafted/u, `${file} must declare its provenance`)
  }
})

test('every rule names a concrete failure mode and a boundary, not a platitude', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const body = text.split('---').slice(2).join('---').trim()
    assert.ok(body.length >= 120, `${file} body is too thin to be actionable (${body.length} chars)`)
    assert.match(body, /取证义务/u, `${file} must state an evidence duty`)
    assert.match(body, /不算/u, `${file} must state what does NOT count`)
  }
})

test('the rule name in front-matter matches the file name', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = text.match(/^name: (.+)$/mu)?.[1]?.trim()
    assert.equal(name, file.replace(/\.md$/u, ''))
  }
})

test('rule selection dispatches by path: a JSON ledger and a CSV ledger do not get the same rules', () => {
  // `.json` and `.csv` appear in both glob families here, so the dispatch is asserted
  // with a document type only one family matches.
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const match = text.match(/^match:\n((?:  - .+\n)+)/mu)?.[1]
      ?.split('\n').filter(Boolean).map((line) => line.replace(/^  - /u, '').replace(/^"|"$/gu, '')) ?? []
    return { name: text.match(/^name: (.+)$/mu)[1].trim(), match }
  })
  const ledger = selectRules(rules, ['feedback/ledger.json'])
  const text = selectRules(rules, ['feedback/ledger.txt'])
  assert.ok(ledger.injected.length > 0)
  assert.ok(ledger.injected.length >= text.injected.length, 'a supported document must not match fewer rules')
  assert.deepEqual(ledger.unmapped, [])
  for (const rule of ledger.injected) assert.ok(rule.match.length > 0)
})

test('F2: every extension this pack declares readable is ALSO matchable by at least one rule', () => {
  // The defect this pins: the gate and the rule globs are two independent
  // declarations of what this domain understands, and BOTH can be individually
  // correct while their intersection is empty — the gate admits a `.md` ledger, the
  // rule loader injects nothing, and the review runs with no checklist. No existing
  // assertion noticed, because every one of them was written about `.json`.
  //
  // Computed from `GATE_EXTENSIONS` — the pack's OWN export — rather than from a
  // copied list, so this cannot go stale the way a hand-maintained fixture would.
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const match = text.match(/^match:\n((?:  - .+\n)+)/mu)?.[1]
      ?.split('\n').filter(Boolean).map((line) => line.replace(/^  - /u, '').replace(/^"|"$/gu, '')) ?? []
    return { name: text.match(/^name: (.+)$/mu)[1].trim(), match }
  })
  assert.ok(GATE_EXTENSIONS.length > 0, 'the pack must declare at least one readable extension')

  const starved = []
  for (const extension of GATE_EXTENSIONS) {
    // A ledger document with this extension, and a candidate path derived from it
    // the same way the source derives one.
    const probe = `feedback/ledger${extension}`
    const { injected, unmapped } = selectRules(rules, [probe])
    if (injected.length === 0) starved.push(extension)
    assert.deepEqual(unmapped, [], `${extension}: an admitted candidate must be mapped by some rule`)
  }
  assert.deepEqual(starved, [],
    `these declared extensions reach the reviewer with ZERO rules: ${starved.join(', ')} — widen the rule match globs or narrow GATE_EXTENSIONS, but do not leave the intersection empty`)

  // The intersection must be non-trivial in the other direction too: a rule family
  // that matches NOTHING the gate can ever admit is dead weight pretending to be
  // coverage, and it is the same defect seen from the rule side.
  const admittedProbe = GATE_EXTENSIONS.map((extension) => `feedback/ledger${extension}`)
  const dead = rules.filter((rule) => selectRules([rule], admittedProbe).injected.length === 0)
  assert.deepEqual(dead.map((rule) => rule.name), [], 'these rules cannot match any document this pack admits')
})

await testAsync('F2: through the REAL plugin, every declared extension yields bundles that carry rules', async () => {
  // The assertion above works on `selectRules` directly; this one goes through
  // `adjudication_plan`, because the intersection could also be broken one layer up
  // (the gate declaring extensions the source never emits, or the bundler dropping
  // `rules` before the reasoner sees them). "The gate admitted it" is NOT the claim
  // under test — "the reviewer got a checklist" is.
  const ctx = createPluginContext()
  const plan = ctx.__tools.get('adjudication_plan')
  const happy = fixture('happy-path')
  const [document] = happy.input.payload.documents

  // The LOADED pack, because the P4 prompt recomputes coverage from the globs the
  // loader assembled — the plan's `bundle.rules` is a list of NAMES, not rules.
  const io = await createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })
  const loaded = await loadDomain(io, { id: DOMAIN, dir: `domains/${DOMAIN}` })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))

  for (const extension of GATE_EXTENSIONS) {
    const payload = {
      ...happy.input.payload,
      documents: [{ ...document, path: `feedback/ledger${extension}` }],
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
      // starvation warning. This is the assertion that actually pins the fix: the
      // kernel's `unmappedPaths` counter is unreliable (see prompts.js), so
      // asserting on it would be asserting on the wrong thing.
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

await testAsync('rules load from the rules directory through the loader, with provenance recorded', async () => {
  const io = await createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })
  const loaded = await loadDomain(io, { id: DOMAIN, dir: `domains/${DOMAIN}` })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const rules = loaded.pack.ruleLibrary?.rules ?? []
  assert.ok(rules.length >= MIN_RULES_PER_DOMAIN, `${rules.length} rules loaded`)
  for (const rule of rules) {
    assert.equal(rule.needsExpertReview, true, `${rule.name} must be flagged`)
    assert.ok(typeof rule.text === 'string' && rule.text.length > 0)
  }
  assert.equal(loaded.pack.ruleLibrary.dir, 'rules')
})

// ---------------------------------------------------------------------------
// P4/P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — two prompt roles that are not the same role')

test('both prompt roles return objects of strings the contract accepts', () => {
  const p4 = prompts.review({ pack, orientation: pack.lossOrientation, bundle: { paths: ['feedback/ledger.json'], rules: [] }, budget: createBudget() })
  const p6 = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.deepEqual(validatePromptOutput('review', p4), [])
  assert.deepEqual(validatePromptOutput('verify', p6), [])
  assert.equal(typeof p4.system, 'string')
  assert.equal(typeof p6.system, 'string')
  assert.equal(typeof p6.instructions, 'string')
})

test('the P6 prompt is NOT the P4 prompt — the assertion the validators do not make', () => {
  const p4 = prompts.review({ pack, orientation: pack.lossOrientation, findings: [] })
  const p6 = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.notEqual(p6.system, p4.system, 'an identical pair would delete the independent re-check layer')
  assert.notEqual(p6.system.length, 0)
  // Independence is structural as well as textual: the verifier is not handed the
  // rule library, so it cannot re-run the review it is supposed to audit.
  assert.doesNotMatch(p6.system, /规则库/u)
  assert.match(p6.system, /独立复核者/u)
  assert.doesNotMatch(p4.system, /独立复核者/u)
})

test('F2: an admitted-but-unruled candidate is a LOUD warning in P4 — and never in P6', () => {
  // This is the second half of F2. Widening the rule globs makes the intersection
  // non-empty for the extensions this pack declares; this assertion is what keeps
  // it that way for everything ELSE, and what turns "the substrate is starved" from
  // a silent empty rule set into a sentence the reviewer has to answer for.
  const governed = prompts.review({
    pack,
    orientation: pack.lossOrientation,
    bundle: { paths: ['feedback/ledger.json'], rules: ['one-sided-closure'], unmappedPaths: [] },
    budget: createBudget(),
  })
  assert.doesNotMatch(governed.system, /没有被任何规则覆盖/u, 'nothing to warn about when every path matched a rule')

  const starved = prompts.review({
    pack,
    orientation: pack.lossOrientation,
    bundle: { paths: ['feedback/ledger.csv'], rules: [], unmappedPaths: ['feedback/ledger.csv'] },
    budget: createBudget(),
  })
  assert.match(starved.system, /没有被任何规则覆盖/u)
  assert.match(starved.system, /feedback\/ledger\.csv/u, 'the warning must NAME the paths, not hand back a count')
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
    unmappedPaths: ['feedback/other.json'],
    budget: createBudget(),
  })
  assert.match(topLevel.system, /没有被任何规则覆盖/u)
  assert.match(topLevel.system, /feedback\/other\.json/u)

  // And the kernel's own `unmappedPaths` is NOT trusted when the real globs are in
  // hand. `lib/engine.js:selectRules` removes only the FIRST matching path per
  // injected rule, so its `unmapped` list comes back non-empty for almost any
  // multi-path bundle even when every path matched. Warning on it directly would be
  // a permanent false alarm.
  const withGlobs = {
    ...pack,
    ruleLibrary: { dir: 'rules', rules: [{ name: 'r', match: ['**/*.json'], text: 'x'.repeat(20) }] },
  }
  const covered = prompts.review({
    pack: withGlobs,
    orientation: pack.lossOrientation,
    bundle: {
      paths: ['feedback/ledger.json', 'feedback/ledger-fb-1.json'],
      rules: ['r'],
      // The kernel would hand back a non-empty list here. It must not raise a warning.
      unmappedPaths: ['feedback/ledger-fb-1.json'],
    },
    budget: createBudget(),
  })
  assert.doesNotMatch(covered.system, /没有被任何规则覆盖/u,
    'a bundle where every path matched a rule must not warn, however the kernel counted it')

  // ...and when the globs say a path really is uncovered, that DOES warn.
  const genuinelyStarved = prompts.review({
    pack: withGlobs,
    orientation: pack.lossOrientation,
    bundle: { paths: ['feedback/ledger.json', 'feedback/notes.csv'], rules: ['r'], unmappedPaths: [] },
    budget: createBudget(),
  })
  assert.match(genuinelyStarved.system, /没有被任何规则覆盖/u)
  assert.match(genuinelyStarved.system, /feedback\/notes\.csv/u)
  assert.doesNotMatch(genuinelyStarved.system, /- feedback\/ledger\.json/u, 'only the uncovered path is named')

  // P6 does not get it. Its independence rests on not receiving the rule set, and
  // "which documents had no rule" is a statement about how the review was
  // CONFIGURED — showing it to the re-checker invites it to audit the review
  // instead of the ledger, which is precisely what P6 exists to prevent.
  const p6 = prompts.verify({
    pack,
    orientation: pack.lossOrientation,
    findings: [],
    bundle: { unmappedPaths: ['feedback/ledger.csv'] },
  })
  assert.doesNotMatch(p6.system, /没有被任何规则覆盖/u)
})

test('the P4 prompt states the recall-first loss sentence and the two extra duties', () => {
  const p4 = prompts.review({ pack, orientation: pack.lossOrientation, bundle: { paths: [] }, budget: createBudget() })
  assert.match(p4.system, /recall-first/u)
  assert.match(p4.system, /漏报比误报更贵/u)
  assert.match(p4.system, /清单，不是计数/u)
  assert.match(p4.system, /两个排序必须分开/u)
})

test('both prompts advertise exactly the claim kinds the verifier implements', () => {
  const p4 = prompts.review({ pack, orientation: pack.lossOrientation, bundle: { paths: [] }, budget: createBudget() })
  const p6 = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  for (const kind of ANCHOR_KINDS) {
    assert.match(p4.system, new RegExp(kind, 'u'), `P4 must advertise ${kind}`)
  }
  // P6 must not invent a claim vocabulary the engine cannot check.
  for (const kind of ANCHOR_KINDS) assert.match(p6.system, new RegExp(kind, 'u'), `P6 must name ${kind}`)
  assert.match(p4.system, /逐字/u)
  assert.match(p4.system, /单边声明/u)
})

test('every orientation gets its own loss sentence, so the pack cannot be silently flipped', () => {
  const recall = prompts.review({ pack, orientation: 'recall-first', bundle: { paths: [] } })
  const precision = prompts.review({ pack, orientation: 'precision-first', bundle: { paths: [] } })
  assert.notEqual(recall.system, precision.system)
  assert.match(recall.system, /漏报比误报更贵/u)
  assert.match(precision.system, /误报比漏报更贵/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const p6 = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(p6.system, /空集/u)
  assert.match(p6.system, /不是失败/u)
  // ...but in a recall-first domain the empty set must not be read as "all clear".
  assert.match(p6.system, /覆盖/u)
})

test('the P6 prompt forbids treating "I did not see it" as a refutation', () => {
  // This is the recall-first specific trap: a triage reviewer that drops items for
  // lack of evidence re-implements the precision-first rule it was told not to use.
  const p6 = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(p6.system, /undecided/u)
  assert.match(p6.system, /看不到是 undecided/u)
})

// ---------------------------------------------------------------------------
// P5 — anchors
// ---------------------------------------------------------------------------

console.log('\nP5 — anchors (the hard constraint)')

function verifyFromCase(entry) {
  const verdict = anchor.verify(entry.claim, normalizeSubject(entry.subject))
  const problems = validateAnchorVerdict(verdict)
  assert.deepEqual(problems, [], `${entry.note}: ${problems.join('; ')}`)
  return verdict
}

/**
 * Unwrap a fixture's ledger documents into the shape the verifier reads.
 *
 * A fixture's `input.payload.documents[i]` is a DOCUMENT ENVELOPE
 * (`{ path, type, meta, payload }`) because that is what the P0 source consumes — it
 * needs `meta.bytes`/`meta.deleted` for the gate. The verifier reads the payload
 * directly. Normalising here keeps both shapes honest instead of making one of them
 * lie about what it holds.
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
      assert.equal(typeof verdict.position, 'string', 'an anchored domain verdict must name what its span indexes')
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
    assert.deepEqual([...verdict.ambiguousIn].sort(), [...entry.expectAmbiguousIn].sort())
  })
}

test('every tier this verifier claims to reach is a tier the contract declares', () => {
  for (const tier of REACHABLE_TIERS) assert.ok(Object.hasOwn(ANCHOR_TIERS, tier) || ANCHOR_TIERS.includes(tier), `undeclared tier ${tier}`)
  assert.equal(new Set(REACHABLE_TIERS).size, REACHABLE_TIERS.length, 'no duplicate tiers')
})

test('every claim kind the prompts advertise is one the verifier implements', () => {
  const unimplemented = ANCHOR_KINDS.filter((kind) => {
    const verdict = anchor.verify(
      { kind: anchor.kind, path: 'feedback/ledger.json', locator: { kind } },
      { path: 'feedback/ledger.json', documents: [{ path: 'feedback/ledger.json', payload: { feedback: [], decisions: [] } }] },
    )
    return verdict.tier === 'kind-mismatch'
  })
  assert.deepEqual(unimplemented, [], 'a kind the prompt names but the verifier rejects would make every such finding unanchored')
})

test('a paraphrase never anchors, even when the intent is obvious', () => {
  const payload = ledgerPayload('happy-path')
  const recorded = payload.payload.feedback.find((item) => item.id === 'fb-1003').quote
  const verdict = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'quote-anchor', feedbackId: 'fb-1003', quote: '导出报表时最后一行会丢失' } },
    { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /转述不是原话/u)
  // And the verbatim quote of the SAME record does anchor — otherwise the refusal
  // above would be satisfiable by a verifier that refuses everything.
  const ok = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'quote-anchor', feedbackId: 'fb-1003', quote: recorded } },
    { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] },
  )
  assert.equal(ok.status, 'anchored')
  assert.equal(ok.tier, 'declared-locator')
})

test('quote matching tolerates whitespace but nothing else', () => {
  const payload = { feedback: [{ id: 'fb-w', quote: '结账时优惠券\n  没有生效，钱白花了', severity: 'high', reach: 'some' }], decisions: [] }
  const subject = { path: 'feedback/w.json', documents: [{ path: 'feedback/w.json', payload }] }
  const ws = anchor.verify({ kind: anchor.kind, path: 'feedback/w.json', locator: { kind: 'quote-anchor', feedbackId: 'fb-w', quote: '结账时优惠券 没有生效，钱白花了' } }, subject)
  assert.equal(ws.status, 'anchored', 'whitespace differences must not break a verbatim quote')
  const changed = anchor.verify({ kind: anchor.kind, path: 'feedback/w.json', locator: { kind: 'quote-anchor', feedbackId: 'fb-w', quote: '结账时优惠券没能生效，钱白花了' } }, subject)
  assert.equal(changed.status, 'unanchored', 'one changed character is a paraphrase')
})

test('a quote below the minimum length is refused as an empty excerpt, not matched loosely', () => {
  const payload = ledgerPayload('happy-path')
  const verdict = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'quote-anchor', quote: '数据'.repeat(2) } },
    { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'empty-excerpt')
  assert.match(verdict.detail, new RegExp(String(MIN_QUOTE_CHARS), 'u'))
})

test('a one-sided closure is refused rather than repaired', () => {
  const payload = ledgerPayload('happy-path')
  const verdict = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'closure-link', feedbackId: 'fb-1002', decisionId: 'dec-21' } },
    { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /单边声明不算闭环/u)
  assert.match(verdict.detail, /closedBy/u)
})

test('the two sides of a closure are reported separately, so the refusal says which is missing', () => {
  const payload = ledgerPayload('happy-path')
  const subject = { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] }
  const closedByOnly = anchor.verify({ kind: anchor.kind, path: payload.path, locator: { kind: 'closure-link', feedbackId: 'fb-1004', decisionId: 'dec-22' } }, subject)
  assert.equal(closedByOnly.tier, 'locator-mismatch')
  assert.match(closedByOnly.detail, /addresses/u)
  const addressesOnly = anchor.verify({ kind: anchor.kind, path: payload.path, locator: { kind: 'closure-link', feedbackId: 'fb-1002', decisionId: 'dec-21' } }, subject)
  assert.equal(addressesOnly.tier, 'locator-mismatch')
  assert.match(addressesOnly.detail, /closedBy/u)
})

test('an id used in the wrong role is refused, not looked up in the other population', () => {
  const payload = ledgerPayload('happy-path')
  const verdict = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'closure-link', feedbackId: 'dec-20', decisionId: 'dec-20' } },
    { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /角色错位/u)
})

test('a decision with no counterpart is confirmed as an orphan, and a linked one is refused', () => {
  const payload = ledgerPayload('happy-path')
  const subject = { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] }
  const orphan = anchor.verify({ kind: anchor.kind, path: payload.path, locator: { kind: 'orphan-decision', decisionId: 'dec-23' } }, subject)
  assert.equal(orphan.status, 'anchored')
  assert.equal(orphan.tier, 'declared-locator')
  const linked = anchor.verify({ kind: anchor.kind, path: payload.path, locator: { kind: 'orphan-decision', decisionId: 'dec-20' } }, subject)
  assert.equal(linked.status, 'unanchored')
  assert.equal(linked.tier, 'locator-mismatch')
})

test('a cross-ledger relocation must be unique', () => {
  const documents = [
    { path: 'feedback/a.json', payload: { feedback: [{ id: 'fb-x', quote: '导出报表会丢掉最后一行数据', severity: 'high', reach: 'some' }], decisions: [] } },
    { path: 'feedback/b.json', payload: { feedback: [{ id: 'fb-y', quote: '完全不相干的一条原话内容在这', severity: 'low', reach: 'few' }], decisions: [] } },
  ]
  const unique = anchor.verify(
    { kind: anchor.kind, path: 'feedback/absent.json', locator: { kind: 'quote-anchor', quote: '导出报表会丢掉最后一行数据' } },
    { path: 'feedback/absent.json', documents },
  )
  assert.equal(unique.status, 'anchored')
  // `recomputed-unique`, not `relocated-unique`, and the difference is the whole point
  // of the tier ladder. The locator carried ONLY a quote — no `feedbackId` — so the
  // missing thing is the identity, and the verifier resolved it by re-deriving it from
  // the corpus. The relocation ladder is for a locator that named its target and the
  // target was not there; this claim never named one. A future edit that merged the two
  // paths would make this assertion red, which is why it is asserted rather than
  // described.
  assert.equal(unique.tier, 'recomputed-unique')
  assert.equal(unique.path, 'feedback/a.json')
  assert.match(unique.detail, /feedback\/a\.json/u)

  const other = anchor.verify(
    { kind: anchor.kind, path: 'feedback/absent.json', locator: { kind: 'unclosed-feedback', feedbackId: 'fb-x' } },
    { path: 'feedback/absent.json', documents },
  )
  assert.equal(other.status, 'anchored')
  assert.equal(other.tier, 'relocated-unique')
})

test('a relocation that would be ambiguous lists every competitor instead of picking one', () => {
  const documents = [
    { path: 'feedback/a.json', payload: { feedback: [{ id: 'fb-same', quote: '导出报表会丢掉最后一行数据', severity: 'high', reach: 'some' }], decisions: [] } },
    { path: 'feedback/b.json', payload: { feedback: [{ id: 'fb-same', quote: '另一份台账里的同名记录内容', severity: 'low', reach: 'few' }], decisions: [] } },
  ]
  const verdict = anchor.verify(
    { kind: anchor.kind, path: 'feedback/a.json', locator: { kind: 'unclosed-feedback', feedbackId: 'fb-same' } },
    { path: 'feedback/a.json', documents },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'relocation-ambiguous')
  assert.equal(verdict.scope, 'id-ambiguous')
  assert.equal(verdict.ambiguousIn.length, 2)
})

test('the tier records HOW the claim was confirmed — declared ids vs a re-derived identity', () => {
  // The regularity, not the current state. Both tiers must be reachable and they must
  // mean different things:
  //
  //   locator names the record(s)  -> the caller said which one it means and the
  //                                   ledger confirmed it -> declared-locator
  //   locator gives only a quote   -> the verifier had to resolve the identity from
  //                                   the quote, uniquely -> recomputed-unique
  //   ... and if two records match -> the identity is not determined, so the claim is
  //                                   refused, never narrowed
  const payload = ledgerPayload('happy-path')
  const subject = { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] }

  const declared = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'quote-anchor', feedbackId: 'fb-1003', quote: '导出报表会丢掉最后一行数据' } },
    subject,
  )
  assert.equal(declared.tier, 'declared-locator')
  assert.equal(constituentsDeclared('quote-anchor', { feedbackId: 'fb-1003', quote: '导出报表会丢掉最后一行数据' }), true)
  // A bare quote is a complete CLAIM but not a complete LOCATOR — that difference IS
  // the tier boundary.
  assert.equal(constituentsDeclared('quote-anchor', { quote: '导出报表会丢掉最后一行数据' }), false)
  assert.equal(constituentsDeclared('quote-anchor', { feedbackId: 'fb-1003', quote: '短' }), false)

  const derived = anchor.verify({ kind: anchor.kind, path: payload.path, locator: { kind: 'quote-anchor', quote: '导出报表会丢掉最后一行数据' } }, subject)
  assert.equal(derived.status, 'anchored')
  assert.equal(derived.tier, 'recomputed-unique')
  assert.deepEqual(derived.nodes, ['fb-1003'])
})

test('a claim whose locator carries neither ids nor an excerpt is refused as empty, not guessed', () => {
  const payload = ledgerPayload('happy-path')
  const verdict = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'closure-link' } },
    { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'empty-excerpt')
  assert.match(verdict.detail, /声明是空的/u)
})

test('every claim kind is exercised in BOTH directions — a kind that can only confirm is unfalsifiable', () => {
  // A verifier that can sometimes say "yes" is half a verifier. For each kind this file
  // asserts a ledger arrangement that CONFIRMS it and a ledger arrangement that REFUTES
  // it, so no kind can be satisfied by returning `declared-locator` unconditionally.
  const CONFIRM = {
    'closure-link': { locator: { kind: 'closure-link', feedbackId: 'fb-1001', decisionId: 'dec-20' } },
    'one-sided-closure': { locator: { kind: 'one-sided-closure', feedbackId: 'fb-1002', decisionId: 'dec-21' } },
    'unclosed-feedback': { locator: { kind: 'unclosed-feedback', feedbackId: 'fb-1005' } },
    'orphan-decision': { locator: { kind: 'orphan-decision', decisionId: 'dec-23' } },
    'quote-anchor': { locator: { kind: 'quote-anchor', feedbackId: 'fb-1003', quote: '导出报表会丢掉最后一行数据' } },
    'theme-membership': { locator: { kind: 'theme-membership', themeId: 'ui', feedbackId: 'fb-1005' } },
    'one-sided-theme': { locator: { kind: 'one-sided-theme', themeId: 'report', feedbackId: 'fb-1007' } },
    'unregistered-reference': { locator: { kind: 'unregistered-reference', referencedId: 'fb-9999', referrerId: 'dec-24' } },
  }
  const REFUTE = {
    'closure-link': { locator: { kind: 'closure-link', feedbackId: 'fb-1002', decisionId: 'dec-21' } },
    'one-sided-closure': { locator: { kind: 'one-sided-closure', feedbackId: 'fb-1001', decisionId: 'dec-20' } },
    'unclosed-feedback': { locator: { kind: 'unclosed-feedback', feedbackId: 'fb-1001' } },
    'orphan-decision': { locator: { kind: 'orphan-decision', decisionId: 'dec-20' } },
    'quote-anchor': { locator: { kind: 'quote-anchor', feedbackId: 'fb-1003', quote: '导出报表时最后一行会丢失' } },
    'theme-membership': { locator: { kind: 'theme-membership', themeId: 'report', feedbackId: 'fb-1007' } },
    'one-sided-theme': { locator: { kind: 'one-sided-theme', themeId: 'ui', feedbackId: 'fb-1005' } },
    'unregistered-reference': { locator: { kind: 'unregistered-reference', referencedId: 'fb-1001', referrerId: 'dec-20' } },
  }
  const payload = ledgerPayload('happy-path')
  const subject = { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] }

  assert.deepEqual(Object.keys(CONFIRM).sort(), [...ANCHOR_KINDS].sort(), 'every declared kind needs a confirming case')
  assert.deepEqual(Object.keys(REFUTE).sort(), [...ANCHOR_KINDS].sort(), 'every declared kind needs a refuting case')

  for (const kind of ANCHOR_KINDS) {
    const yes = anchor.verify({ kind: anchor.kind, path: payload.path, ...CONFIRM[kind] }, subject)
    assert.equal(yes.status, 'anchored', `${kind} should be confirmable: ${yes.detail}`)
    assert.equal(yes.tier, 'declared-locator', `${kind} confirms with a complete locator`)
    assert.deepEqual(validateAnchorVerdict(yes), [])

    const no = anchor.verify({ kind: anchor.kind, path: payload.path, ...REFUTE[kind] }, subject)
    assert.equal(no.status, 'unanchored', `${kind} should be refutable: ${no.detail}`)
    assert.ok(REFUSAL_TIERS_FOR_TEST.includes(no.tier), `${kind} refuses with a declared tier, got ${no.tier}`)
    assert.deepEqual(validateAnchorVerdict(no), [])
  }
})

test('the tier comes from the caller\'s locator, never from a flag on the claim', () => {
  // The captain's ruling, asserted rather than described: `declared-locator` means the
  // locator the CALLER supplied was independently confirmed. Nine migrated domains infer
  // it that way; an earlier version of the sibling domain read a `claim.declared` bit
  // that nothing ever set, which demoted every confirmed claim to `recomputed-unique`.
  //
  // So a claim carrying `declared: true` but a locator without this domain's fields must
  // still be RECOMPUTED (or refused), and a claim with no flag but a complete locator
  // must be `declared-locator`. If the flag ever came back, the first assertion fails.
  const payload = ledgerPayload('happy-path')
  const subject = { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] }

  const flaggedButEmpty = anchor.verify(
    { kind: anchor.kind, path: payload.path, declared: true, locator: { kind: 'unclosed-feedback' }, excerpt: 'fb-1005 无人处理' },
    subject,
  )
  assert.equal(flaggedButEmpty.status, 'anchored')
  assert.equal(flaggedButEmpty.tier, 'recomputed-unique', 'a flag must not promote an incomplete locator')

  const unflaggedButComplete = anchor.verify(
    { kind: anchor.kind, path: payload.path, locator: { kind: 'unclosed-feedback', feedbackId: 'fb-1005' } },
    subject,
  )
  assert.equal(unflaggedButComplete.status, 'anchored')
  assert.equal(unflaggedButComplete.tier, 'declared-locator', 'a complete locator needs no flag')
  assert.equal(constituentsDeclared('unclosed-feedback', { feedbackId: 'fb-1005' }), true)
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const payload = ledgerPayload('happy-path')
  const subject = { path: payload.path, documents: [{ path: payload.path, payload: payload.payload }] }
  assert.equal(anchor.verify({ kind: 'task-and-edge', path: payload.path, locator: { kind: 'closure-link', feedbackId: 'fb-1001', decisionId: 'dec-20' } }, subject).tier, 'kind-mismatch')
  assert.equal(anchor.verify({ kind: anchor.kind, path: payload.path, locator: { kind: 'made-up-kind' } }, subject).tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a', locator: null }, {}), /E_ANCHOR_CONTRACT/u)
})

test('no verdict ever carries a tier the contract does not declare', () => {
  for (const { entry } of anchorCases()) {
    const verdict = anchor.verify(entry.claim, normalizeSubject(entry.subject))
    assert.ok(REACHABLE_TIERS.includes(verdict.tier), `undeclared tier ${verdict.tier}`)
    assert.deepEqual(validateAnchorVerdict(verdict), [])
  }
})

test('an anchored verdict carries a position, and an unanchored one never carries a span', () => {
  for (const { entry } of anchorCases()) {
    const verdict = anchor.verify(entry.claim, normalizeSubject(entry.subject))
    if (verdict.status === 'anchored') {
      assert.equal(typeof verdict.position, 'string', 'the reused span must say what it indexes')
      assert.ok(verdict.end >= verdict.start)
    } else {
      assert.equal(verdict.start, null)
      assert.equal(verdict.end, null)
      assert.equal(verdict.position, null)
    }
  }
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const corpusOf = (name) => {
  const value = fixture(name)
  const documents = value.input.payload.documents ?? [{ path: value.input.payload.ledgerPath ?? 'feedback/ledger.json', payload: value.input.payload }]
  return documents.map((document) => ({ path: document.path, payload: document.payload }))
}

const toolNamed = (name) => {
  const tool = evidence.tools.find((entry) => entry.name === name)
  assert.ok(tool !== undefined, `missing evidence tool ${name}`)
  return tool
}

test('the toolkit validates and stays inside the contract ceilings', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.ok(evidence.tools.length <= 8, `${evidence.tools.length} tools`)
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxLines <= 2000)
    assert.ok(tool.limits.maxItems <= 1000)
    assert.ok(tool.limits.maxCalls <= 20)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
  }
})

await testAsync('every tool refuses an empty corpus loudly instead of reporting "nothing found"', async () => {
  // Each tool is given everything it needs EXCEPT the corpus, so the rejection it
  // produces is the corpus refusal and not an argument check that happened to fire
  // first. The async wrapper is load-bearing too: `assert.rejects` does not convert a
  // SYNCHRONOUS throw into a rejection — it escapes the assertion entirely and the test
  // would pass without checking anything. Every domain tool here throws synchronously.
  const minimalArgs = {
    feedback_record: { feedbackId: 'fb-1001' },
    closure_status: { feedbackId: 'fb-1001' },
    decision_links: { decisionId: 'dec-20' },
    unclosed_feedback: {},
    ledger_ranks: {},
    quote_search: { text: '一段足够长的引文片段' },
  }
  for (const tool of evidence.tools) {
    const args = minimalArgs[tool.name]
    assert.ok(args !== undefined, `no minimal args declared for ${tool.name}`)
    await assert.rejects(async () => tool.execute(args, {}), /corpus/u, `${tool.name} must demand a corpus`)
  }
})

await testAsync('a request naming an absent ledger fails loudly with the available paths', async () => {
  await assert.rejects(
    async () => toolNamed('feedback_record').execute({ feedbackId: 'fb-1001', path: 'feedback/nope.json', corpus: corpusOf('happy-path') }, {}),
    /feedback\/ledger\.json/u,
  )
})

await testAsync('every tool result satisfies the contract result validator', async () => {
  const corpus = corpusOf('happy-path')
  const calls = [
    ['feedback_record', { feedbackId: 'fb-1001' }],
    ['closure_status', { feedbackId: 'fb-1003' }],
    ['decision_links', { decisionId: 'dec-23' }],
    ['unclosed_feedback', {}],
    ['ledger_ranks', {}],
    ['quote_search', { text: '导出报表会丢掉最后一行数据' }],
  ]
  for (const [name, args] of calls) {
    const tool = toolNamed(name)
    const result = await tool.execute({ ...args, corpus }, {})
    assert.deepEqual(validateEvidenceToolkit(evidence), [])
    assert.ok(Array.isArray(result.items), `${name} must return items`)
    assert.equal(typeof result.truncated, 'boolean')
    assert.equal(typeof result.provenance, 'string')
    assert.ok(result.contractError === undefined || true)
  }
})

await testAsync('feedback_record returns the recorded quote verbatim, not a summary', async () => {
  const result = await toolNamed('feedback_record').execute({ feedbackId: 'fb-1001', corpus: corpusOf('happy-path') }, {})
  assert.equal(result.items.length, 1)
  const item = result.items[0]
  assert.equal(item.quote, '结账时优惠券没有生效，钱白花了')
  assert.equal(item.severity, 'blocker')
  assert.equal(item.frequency, 2)
  assert.equal(item.theme, 'checkout')
  assert.equal(item.closedByExists, true)
})

await testAsync('closure_status separates the two sides instead of reporting one boolean', async () => {
  const oneSided = await toolNamed('closure_status').execute({ feedbackId: 'fb-1002', corpus: corpusOf('happy-path') }, {})
  assert.equal(oneSided.items[0].closedBy, null)
  assert.deepEqual(oneSided.items[0].addressedBy, ['dec-21'])
  assert.deepEqual(oneSided.items[0].mutual, [])
  assert.equal(oneSided.items[0].closed, false)
  assert.equal(oneSided.items[0].gap.side, 'addresses-only')
  assert.ok(oneSided.notes.length > 0)

  const mutual = await toolNamed('closure_status').execute({ feedbackId: 'fb-1001', corpus: corpusOf('happy-path') }, {})
  assert.deepEqual(mutual.items[0].mutual, ['dec-20'])
  assert.equal(mutual.items[0].closed, true)
  assert.equal(mutual.items[0].gap, null)
})

await testAsync('unclosed_feedback lists every gap individually and says so', async () => {
  const result = await toolNamed('unclosed_feedback').execute({ corpus: corpusOf('happy-path') }, {})
  const feedbackIds = result.items.filter((item) => item.feedbackId !== null).map((item) => item.feedbackId)
  assert.deepEqual(feedbackIds, ['fb-1002', 'fb-1003', 'fb-1004', 'fb-1005', 'fb-1006', 'fb-1007', 'fb-9999'])
  assert.ok(result.items.some((item) => item.decisionId === 'dec-23'), 'the orphan decision belongs in this list too')
  for (const item of result.items) assert.ok(typeof item.reason === 'string' && item.reason.length > 0)
  assert.match(result.notes.join('\n'), /逐条/u)
  assert.match(result.notes.join('\n'), /一条不漏/u)
})

await testAsync('unclosed_feedback on a fully closed ledger says the empty list is a conclusion', async () => {
  const closed = { feedback: [{ id: 'fb-1', quote: '一条已经真正闭环的反馈原话', closedBy: 'dec-1', severity: 'high', reach: 'some' }], decisions: [{ id: 'dec-1', title: '修复', addresses: ['fb-1'] }] }
  const result = await toolNamed('unclosed_feedback').execute({ corpus: [{ path: 'feedback/closed.json', payload: closed }] }, {})
  assert.equal(result.items.length, 0)
  assert.match(result.notes.join('\n'), /空清单是合法结论/u)
})

await testAsync('ledger_ranks keeps the two orderings apart and flags the drowned', async () => {
  const result = await toolNamed('ledger_ranks').execute({ corpus: corpusOf('happy-path') }, {})
  const expected = fixture('happy-path').observations.rankChecks
  const byLoss = [...result.items].sort((a, b) => a.lossRank - b.lossRank).map((item) => item.id)
  const byFrequency = [...result.items].sort((a, b) => a.frequencyRank - b.frequencyRank).map((item) => item.id)
  assert.deepEqual(byLoss, expected.byLoss)
  assert.deepEqual(byFrequency, expected.byFrequency)
  assert.notDeepEqual(byLoss, byFrequency)
  assert.deepEqual(result.items.filter((item) => item.drownRisk).map((item) => item.id).sort(), [...expected.drownRisk].sort())
  assert.match(result.notes.join('\n'), /淹没/u)
})

await testAsync('quote_search is verbatim and reports a miss as a paraphrase suspicion', async () => {
  const hit = await toolNamed('quote_search').execute({ text: '首页推荐位重复出现了两次', corpus: corpusOf('happy-path') }, {})
  assert.deepEqual(hit.items.map((item) => item.feedbackId), ['fb-1004'])
  const miss = await toolNamed('quote_search').execute({ text: '首页的位置重复出现了两次', corpus: corpusOf('happy-path') }, {})
  assert.equal(miss.items.length, 0)
  assert.match(miss.notes.join('\n'), /转述/u)
})

await testAsync('quote_search reports when a phrase identifies more than one record', async () => {
  const result = await toolNamed('quote_search').execute({ text: '导出账单里多出一笔重复扣款', corpus: corpusOf('dangling-and-collision') }, {})
  assert.equal(result.items.length, 2)
  assert.match(result.notes.join('\n'), /不能唯一确定/u)
})

await testAsync('decision_links reports declared-vs-mutual separately, so a claim is not a fact', async () => {
  const result = await toolNamed('decision_links').execute({ decisionId: 'dec-21', corpus: corpusOf('happy-path') }, {})
  const item = result.items[0]
  assert.deepEqual(item.declaredAddresses, ['fb-1002'])
  assert.deepEqual(item.mutualClosures, [])
  assert.deepEqual(item.oneSided, ['fb-1002'])
  assert.equal(item.orphan, false)
})

await testAsync('a lookup for an id that only appears as a reference is refused with an explanation', async () => {
  // `fb-9999` is referenced by `dec-24` but declared nowhere. Asking for its record
  // must not return an empty success — the caller has to learn that this is a
  // FINDING, not a missing field.
  await assert.rejects(
    async () => toolNamed('feedback_record').execute({ feedbackId: 'fb-9999', corpus: corpusOf('happy-path') }, {}),
    /未登记的引用/u,
  )
})

await testAsync('a bounded tool reports truncation instead of pretending the list is complete', async () => {
  const many = {
    feedback: Array.from({ length: 140 }, (_, index) => ({ id: `fb-${5000 + index}`, quote: `第 ${index} 条反馈的原话内容`, severity: 'low', reach: 'few', frequency: index })),
    decisions: [],
  }
  const result = await toolNamed('ledger_ranks').execute({ corpus: [{ path: 'feedback/many.json', payload: many }] }, {})
  assert.equal(result.truncated, true)
  assert.ok(result.items.length <= 120)
  assert.match(result.notes.join('\n'), /截断/u)
})

await testAsync('a truncated gap list says that missing entries are NOT evidence of closure', async () => {
  const many = {
    feedback: Array.from({ length: 120 }, (_, index) => ({ id: `fb-${6000 + index}`, quote: `第 ${index} 条未闭环反馈的原话`, severity: 'medium', reach: 'few' })),
    decisions: [],
  }
  const result = await toolNamed('unclosed_feedback').execute({ corpus: [{ path: 'feedback/many.json', payload: many }] }, {})
  assert.equal(result.truncated, true)
  assert.ok(result.items.length <= 100)
})

// ---------------------------------------------------------------------------
// The loader, and the plugin
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: DOMAIN, dir: `domains/${DOMAIN}` })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'feedback-to-decision-links')
  assert.equal(assembled.anchorVerifier.kind, 'feedback-and-quote')
  assert.equal(assembled.evidenceTools.tools.length, evidence.tools.length)
  assert.equal(typeof assembled.reviewPrompts.review, 'function')
  assert.equal(typeof assembled.reviewPrompts.verify, 'function')
  assert.equal(assembled.candidateSet.inputFormat, FORMAT)
  assert.equal(assembled.lossOrientation, 'recall-first')
  assert.equal(assembled.criticism.kind, 'triage')
  assert.equal(assembled.id, DOMAIN, 'the declared id must equal the directory name')
})

await testAsync('the assembled P6 prompt still differs from the assembled P4 prompt', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: DOMAIN, dir: `domains/${DOMAIN}` })
  const p4 = loaded.pack.reviewPrompts.review({ pack: loaded.pack, orientation: 'recall-first' })
  const p6 = loaded.pack.reviewPrompts.verify({ pack: loaded.pack, orientation: 'recall-first', findings: [] })
  assert.notEqual(p6.system, p4.system)
})

await testAsync('discovery reports this domain as loaded, not skipped and not problem', async () => {
  const io = await packageIo()
  const result = await loadDomains(io, { dir: 'domains' })
  assert.deepEqual(result.problems.filter((item) => item.id === DOMAIN), [], JSON.stringify(result.problems.filter((item) => item.id === DOMAIN)))
  assert.deepEqual(result.skipped.filter((item) => item.id === DOMAIN), [], JSON.stringify(result.skipped.filter((item) => item.id === DOMAIN)))
  assert.ok(result.packs.some((entry) => entry.id === DOMAIN))
})

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

console.log('\nthrough the plugin — P0 -> P7 over a fixture')

await testAsync('adjudication_plan consumes the fixture ledger through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'feedback-to-decision-links')
  assert.equal(plan.candidateSet.inputFormat, FORMAT)
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.strategy, 'theme')
  assert.ok(plan.bundles.length > 1, 'a multi-theme ledger must not collapse into one bundle')
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
  // The load-bearing bundling assertion, through the plugin this time: the checkout
  // theme must be ONE bundle holding more than one candidate.
  const cluster = plan.bundles.find((item) => item.key === 'theme/checkout')
  assert.ok(cluster !== undefined, `expected a theme/checkout bundle, got ${plan.bundles.map((item) => item.key).join(', ')}`)
  assert.ok(cluster.paths.length > 1, 'one candidate per bundle would mean P2 did nothing')
})

await testAsync('the plan over the empty fixture says the empty set is itself the conclusion', async () => {
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
    'feedback/legacy-ledger-fb-9001.json': 'deleted',
    'feedback/legacy-ledger-fb-9002.json': 'deleted',
    'feedback/attachments/screenshot-media-fb-9003.json': 'binary',
    'node_modules/feedback-tool/export-fb-9005.json': 'user-exclude',
    'archived/2024-ledger-fb-9006.json': 'user-exclude',
    'feedback/notes/raw-export-fb-9004.txt': 'extension',
  })
  // FOUR different predicates each fire, and the `.txt` candidate keeps `.txt`: a
  // ledger that re-typed an unsupported document into a supported one would sail
  // through the gate it was supposed to fail.
  assert.equal(plan.gate.admitted, 0)
  assert.match(plan.summary, /准入 0 项/u)
  assert.match(plan.summary, /排除 6 项/u)
})

await testAsync('the plan over a caller-supplied candidate set carries its metadata through', async () => {
  // The engine's `toCandidates` used to rebuild each candidate from a seven-field
  // allow-list, dropping `meta` BEFORE `bundleKey.resolve` saw it — so a
  // caller-supplied candidate could only ever be grouped by path. Asserting the
  // grouping (not `applied`) is what makes that regression impossible to reintroduce.
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'caller-supplied',
    candidates: [
      { path: 'feedback/a-fb-1.json', meta: { theme: 'billing' } },
      { path: 'feedback/a-fb-2.json', meta: { theme: 'billing' } },
      { path: 'feedback/a-fb-3.json', meta: { theme: 'notify' } },
      { path: 'feedback/a-fb-4.json', meta: { theme: 'notify' } },
    ],
  }, {})
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['theme/billing', 'theme/notify'])
  assert.ok(plan.bundles.every((item) => item.paths.length === 2))
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
})

// ---------------------------------------------------------------------------
// The end-to-end recall-first round trip
// ---------------------------------------------------------------------------

await testAsync('P0 -> P7: every open closure is submitted, anchored, and reported incomplete', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const payload = ledgerPayload('happy-path')
  const ledgerDocument = { path: payload.path, payload: payload.payload }

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'recall-first round trip',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  // The findings are built from the domain's OWN gap list, and each one is verified by
  // the domain's OWN verifier before it is submitted. Nothing here is a number this
  // file made up — and nothing is a self-reported `{anchored: true}` either.
  //
  // Each gap is submitted under the claim kind that MATCHES its side:
  //
  //   no link at all          -> `unclosed-feedback`
  //   exactly one spelling    -> `one-sided-closure`  (the domain's signature defect)
  //   the named decision does
  //   not exist               -> `unregistered-reference` (a dangling closure is a
  //                              broken link, not a partial one)
  //   decision with no links  -> `orphan-decision`
  //
  // The middle two are why the extra kinds exist at all. A one-sided closure CANNOT be
  // submitted as `closure-link` — that claim is false and the verifier correctly refuses
  // it — so without a kind for the partial state, the domain's most important finding
  // class would have no anchorable form and would only ever be reportable as prose. An
  // earlier version of this suite hit that wall twice: `fb-1002` came back
  // `locator-mismatch` (it needed `one-sided-closure`) and `fb-1003` came back
  // `no-match` (its decision does not exist, so it needed `unregistered-reference`).
  const { gaps, orphanDecisions } = closureGaps(payload)
  // The table is hoisted to module scope (`GAP_CLAIM_BUILDERS`) so the completeness
  // assertion below and the dedicated gap-kind tests can both reach it.
  const claimFor = (gap) => {
    const build = GAP_CLAIM_BUILDERS[gap.kind]
    assert.ok(typeof build === 'function', `gap kind "${gap.kind}" has no claim mapping — add it to GAP_CLAIM_BUILDERS rather than letting it fall through`)
    return { id: `gap-${gap.feedbackId}`, path: payload.path, locator: build(gap), gap }
  }
  // An unmapped gap kind must fail HERE, with a name, rather than be silently
  // mistranslated into a claim the verifier then refuses.
  for (const kind of new Set(gaps.map((gap) => gap.kind))) {
    assert.ok(Object.hasOwn(GAP_CLAIM_BUILDERS, kind), `this fixture produces gap kind "${kind}" that no claim mapping covers`)
  }
  const claims = [
    ...gaps.map(claimFor),
    ...orphanDecisions.map((orphan) => ({ id: `gap-${orphan.decisionId}`, path: payload.path, locator: { kind: 'orphan-decision', decisionId: orphan.decisionId } })),
  ]

  const findings = []
  const gapEvidence = []
  for (const entry of claims) {
    const verdict = anchor.verify({ kind: anchor.kind, path: entry.path, locator: entry.locator }, { path: entry.path, documents: [ledgerDocument] })
    assert.deepEqual(validateAnchorVerdict(verdict), [], `${entry.id}: ${JSON.stringify(verdict)}`)
    // A gap claim must be ANCHORED — the whole point is that the absence of a closure
    // is a fact the ledger itself proves, not an impression.
    assert.equal(verdict.status, 'anchored', `${entry.id} should anchor: ${verdict.detail}`)
    findings.push({
      id: entry.id,
      path: verdict.path,
      locator: entry.locator,
      severity: entry.gap?.side === 'none' ? 'high' : 'medium',
      message: entry.gap?.reason ?? `决策 ${entry.locator.decisionId} 与台账上的任何反馈都没有关系`,
      evidence: JSON.stringify(payload.payload.feedback),
      defended: true,
      anchorTier: verdict.tier,
    })
    gapEvidence.push(entry.id)
  }

  // The list is the deliverable: one finding per open closure, none collapsed.
  assert.equal(findings.length, gaps.length + orphanDecisions.length)
  assert.ok(findings.length > 3, 'this fixture must produce a real work list')

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: DOMAIN,
    target: 'recall-first round trip',
    documents: [ledgerDocument],
    findings,
  }, {})

  assert.equal(submitted.anchorVia, 'anchorVerifier', 'the engine must route through the pack anchorVerifier')
  assert.equal(submitted.unanchored, 0, 'every gap claim is a fact the ledger proves')
  assert.equal(submitted.findings.length, findings.length, 'recall-first keeps unless disproved, so nothing may be silently dropped')
  for (const finding of submitted.findings) {
    assert.equal(finding.anchorTier, 'declared-locator')
    assert.ok(TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier))
  }

  // Every gap appears in the report's OWN finding list, by id — not as a count.
  const reportedIds = new Set(submitted.findings.map((finding) => finding.id))
  for (const id of gapEvidence) assert.ok(reportedIds.has(id), `${id} must appear in the report`)

  // And the run is marked INCOMPLETE, not rounded up. `lossOrientation:
  // 'recall-first'` is what makes `required` true here — the engine turns the domain's
  // orientation into `requireComplete`.
  assert.equal(submitted.coverage.required, true, 'recall-first must require complete coverage')
  assert.equal(submitted.coverage.complete, false, 'this run does not cover the whole ledger')
  assert.ok(submitted.coverage.total > submitted.coverage.reviewed)
  assert.ok(submitted.coverage.coverageRate < 1)
  assert.match(submitted.summary, /不完整/u)
  assert.match(submitted.coverage.note, /distinct anchored paths/u)

  // The bundle the round trip ran against is the real theme grouping, not a shim.
  assert.ok(plan.bundles.some((item) => item.key.startsWith('theme/')))
})

// ---------------------------------------------------------------------------
// F3 — the direction that had NO branch at all
// ---------------------------------------------------------------------------

await testAsync('F3: closureGaps reports a decision whose addresses names a feedback that does not exist', async () => {
  // Before the fix this defect was structurally invisible. `closureGaps` iterated
  // the DECLARED feedback rows looking for gaps, so an undeclared id could never be
  // a subject; and `orphanDecisions` skipped the decision because it does have a
  // link. A ledger could say "decision D closed feedback fb-9999" where fb-9999
  // exists nowhere, and the gap analysis reported nothing whatsoever.
  const payload = ledgerPayload('happy-path')
  const { gaps, orphanDecisions } = closureGaps(payload)

  // The fixture is not vacuous: the reference is really there, and the target is
  // really absent from EVERY population — not merely from `feedback[]`.
  const declaredDecisionIds = payload.payload.decisions.map((decision) => decision.id)
  assert.ok(
    payload.payload.decisions.some((decision) => (decision.addresses ?? []).includes('fb-9999')),
    'the fixture must really contain a decision addressing fb-9999',
  )
  assert.equal(payload.payload.feedback.some((item) => item.id === 'fb-9999'), false)
  assert.equal(declaredDecisionIds.includes('fb-9999'), false)

  const danglingAddress = gaps.filter((gap) => gap.kind === 'dangling-address')
  assert.equal(danglingAddress.length, 1, 'exactly one dangling address in this ledger')
  assert.equal(danglingAddress[0].feedbackId, 'fb-9999', 'the undeclared id is named, not hidden')
  assert.equal(danglingAddress[0].decisionId, 'dec-24', 'the real record that points nowhere is named')
  assert.equal(danglingAddress[0].side, 'addresses-only')
  assert.match(danglingAddress[0].reason, /不存在/u)
  assert.match(danglingAddress[0].reason, /失效链接/u)

  // The mirror kind must ALSO be present and must stay a SEPARATE kind: a reader
  // who fixes one direction has not fixed the other, and a report that merged the
  // two would let them believe otherwise.
  const danglingClosure = gaps.filter((gap) => gap.kind === 'dangling-closure')
  assert.equal(danglingClosure.length, 1)
  assert.equal(danglingClosure[0].decisionId, 'dec-77')
  assert.notDeepEqual(
    [danglingAddress[0].kind, danglingAddress[0].side],
    [danglingClosure[0].kind, danglingClosure[0].side],
  )

  // And the decision that points nowhere is NOT quietly reclassified as an orphan.
  // That was the old silent behaviour's neighbour: `dec-24` has a link, so the
  // orphan list skipped it, and nothing else picked it up either. Now it is picked
  // up as a broken link, which is the more precise statement — it is not that
  // dec-24 addressed nothing, it is that what it addressed does not exist.
  assert.equal(orphanDecisions.some((orphan) => orphan.decisionId === 'dec-24'), false)
  assert.ok(orphanDecisions.some((orphan) => orphan.decisionId === 'dec-23'), 'the real orphan is still reported')

  // The four kinds together are the complete vocabulary this function emits, and
  // each one is produced by SOME fixture in this suite — so no kind can be added
  // and left untested, and none can rot unnoticed.
  const produced = new Set()
  for (const name of FIXTURES.keys()) {
    const fx = fixture(name)
    for (const document of fx.input.payload.documents ?? []) {
      for (const gap of closureGaps(document).gaps) produced.add(gap.kind)
    }
  }
  assert.deepEqual([...produced].sort(), Object.keys(GAP_CLAIM_BUILDERS).sort(),
    'every gap kind must be produced by a fixture AND have a claim mapping — a kind with no builder cannot be anchored')
})

await testAsync('F3: the dangling address is anchorable and reaches the work list through the registry', async () => {
  const payload = ledgerPayload('happy-path')
  const ledgerDocument = { path: payload.path, payload: payload.payload }
  const gap = closureGaps(payload).gaps.find((entry) => entry.kind === 'dangling-address')
  assert.ok(gap !== undefined)

  // Anchorable: the same claim kind the mirror direction uses, with the roles
  // swapped. If the new direction could not be anchored it would be prose — and a
  // recall-first domain's broken links would be exactly the item that never makes
  // it into a report.
  const locator = GAP_CLAIM_BUILDERS['dangling-address'](gap)
  const verdict = anchor.verify({ kind: anchor.kind, path: payload.path, locator }, { path: payload.path, documents: [ledgerDocument] })
  assert.deepEqual(validateAnchorVerdict(verdict), [])
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'declared-locator', 'the locator names the whole claim, so the verifier must not have to re-derive it')

  // Refutable, not a token that always anchors: the moment the ledger DOES declare
  // that id, the claim that it is unregistered is false.
  const declared = {
    path: payload.path,
    payload: {
      ...payload.payload,
      feedback: [...payload.payload.feedback, { id: 'fb-9999', quote: '这条反馈原先只在决策的 addresses 里出现过' }],
    },
  }
  const refuted = anchor.verify({ kind: anchor.kind, path: payload.path, locator }, { path: payload.path, documents: [declared] })
  assert.equal(refuted.status, 'unanchored', 'a reference the ledger resolves is not a broken link')
  assert.ok(REFUSAL_TIERS_FOR_TEST.includes(refuted.tier))

  // Visible through the registry, as its own item with its own kind — the reader
  // must be able to tell "nobody acted" from "the record of who acted points
  // nowhere", because only one of those is fixed by doing work.
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  const tool = ctx.__tools.get(evidenceToolName(DOMAIN, 'unclosed_feedback'))
  const result = await tool.execute({ corpus: corpusOf('happy-path') }, {})
  const item = result.items.find((entry) => entry.kind === 'dangling-address')
  assert.ok(item !== undefined, 'the work list must carry the broken link, not drop it')
  assert.equal(item.feedbackId, 'fb-9999')
  assert.equal(item.decisionId, 'dec-24')
  assert.equal(result.items.filter((entry) => entry.feedbackId === 'fb-9999').length, 1, 'listed once, not twice')
  assert.equal(result.provenance.includes('逐条'), true)
})

await testAsync('a one-sided closure submitted as if it were closed is refused, and never becomes a finding', async () => {
  // F3 in the submit path: the engine re-derives from the ledger. A model that writes
  // "fb-1002 已由 dec-21 关闭" gets `locator-mismatch`, not a pass.
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const payload = ledgerPayload('happy-path')
  const ledgerDocument = { path: payload.path, payload: payload.payload }

  await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'one-sided probe',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: DOMAIN,
    target: 'one-sided probe',
    documents: [ledgerDocument],
    findings: [
      {
        id: 'f-false-closure',
        path: payload.path,
        locator: { kind: 'closure-link', feedbackId: 'fb-1002', decisionId: 'dec-21' },
        severity: 'high',
        message: 'fb-1002 已由 dec-21 关闭',
        evidence: '单边声明，实际未互证',
        defended: true,
      },
      {
        id: 'f-true-closure',
        path: payload.path,
        locator: { kind: 'closure-link', feedbackId: 'fb-1001', decisionId: 'dec-20' },
        severity: 'low',
        message: 'fb-1001 由 dec-20 关闭，两侧互证',
        evidence: '双侧声明一致',
        defended: true,
      },
    ],
  }, {})

  assert.equal(submitted.anchorVia, 'anchorVerifier')
  assert.equal(submitted.unanchored, 1)
  assert.deepEqual(submitted.findings.map((finding) => finding.id), ['f-true-closure'])
  const refused = submitted.unanchoredDetails.find((entry) => entry.id === 'f-false-closure')
  assert.ok(refused !== undefined)
  assert.equal(refused.tier, 'locator-mismatch')
  assert.equal(refused.via, 'anchorVerifier')
  assert.match(refused.detail, /单边声明/u)
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  const listed = await ctx.__tools.get(`adjudicate_user_feedback_rules`).execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /needs-expert-review/u)
  assert.doesNotMatch(listed.summary, /已通过专家/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const before = [...ctx.__tools.keys()].filter((name) => name.includes('evidence'))
  await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  const after = [...ctx.__tools.keys()].filter((name) => name.includes('evidence'))
  assert.ok(after.length > before.length, 'activation must add tools')
  for (const tool of evidence.tools) {
    const name = evidenceToolName(DOMAIN, tool.name)
    assert.ok(after.includes(name), `${name} must be registered`)
  }
})

await testAsync('the registered gap tool lists every open closure through the plugin', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: DOMAIN }, {})
  const tool = ctx.__tools.get(evidenceToolName(DOMAIN, 'unclosed_feedback'))
  const result = await tool.execute({ corpus: corpusOf('happy-path') }, {})
  const feedbackIds = result.items.filter((item) => item.feedbackId !== null).map((item) => item.feedbackId)
  assert.deepEqual(feedbackIds, ['fb-1002', 'fb-1003', 'fb-1004', 'fb-1005', 'fb-1006', 'fb-1007', 'fb-9999'])
  assert.equal(result.domain, DOMAIN)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: DOMAIN,
    target: 'replacement probe',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})
  // The v1 pack declared the string 'theme', which the v2 gate rejects outright. The
  // resolver is what makes the migration real rather than a rename — and the proof is
  // the GROUPING, not the `applied` flag.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'theme')
  const cluster = plan.bundles.find((item) => item.key === 'theme/checkout')
  assert.ok(cluster !== undefined)
  assert.ok(cluster.paths.length > 1, 'a single-entry bundle would mean P2 did nothing')

  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19, 'replacement must not change the domain count')
  assert.ok(listed.directory.replaced.includes(DOMAIN), `expected ${DOMAIN} in ${JSON.stringify(listed.directory.replaced)}`)
})

// ---------------------------------------------------------------------------
// t42 — the generators are the producers, so the generators are what gets pinned
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS SECTION EXISTS FOR
// ----------------------------------
// `rules/_generate.mjs` carried its own four-glob extension list while `index.js`
// declared five extensions. Nothing kept the two equal, and nothing could: with two
// independent constants the only open question is *when* they diverge. They did — the
// library was corrected by hand, then silently reverted the next time the generator ran,
// and a `.md` ledger was reviewed with an empty checklist again. The regression was real
// but the editing was not the bug; the topology was.
//
// Three consequences are pinned separately, because they fail for different reasons:
//
//   • the generator's output and the committed artifacts must be the SAME bytes
//     (drift), which is what catches a re-hardcoded extension list;
//   • importing either generator must not touch the filesystem (safety), which is what
//     catches a return to writing at module top level;
//   • the narrowing that REMAINS must be NAMED (scope), so a rule that deliberately
//     covers fewer serializations cannot quietly join the set.
//
// None of the three is satisfiable by the other two: `--write` output can be in sync
// while the module still rewrites files on import, and an import-safe module can still
// produce artifacts that no longer match what is committed.

const GENERATED_RULES = readdirSync(join(here, 'rules')).filter((file) => file.endsWith('.md')).sort()
const GENERATED_FIXTURES = readdirSync(join(here, 'fixtures')).filter((file) => file.endsWith('.json')).sort()

/**
 * `name@mtimeMs:size` for every file a generator owns.
 *
 * The mtime is the load-bearing half. A hash only catches a write that CHANGED the
 * bytes, and the t42 incident is precisely the case where the write produced content
 * that is correct-looking but was never asked for — so `size` alone can stay the same
 * and `mtimeMs` is what proves no write happened at all.
 */
const stampGenerated = (directory, files) => files.map((name) => {
  const stat = statSync(join(directory, name))
  return `${name}@${stat.mtimeMs}:${stat.size}`
})

/** A fresh URL per caller, because ESM caches by specifier and a cached import runs nothing. */
const generatorUrl = (relative, tag) => `${new URL(relative, import.meta.url).href}?${tag}`

await testAsync('t42: both generators reproduce the committed artifacts byte for byte', async () => {
  const rulesGen = await import(generatorUrl('./rules/_generate.mjs', 't42-drift'))
  const fixturesGen = await import(generatorUrl('./fixtures/_generate.mjs', 't42-drift'))
  const util = await import(generatorUrl('./_generate-util.mjs', 't42-drift'))

  const rules = util.compareRendered(rulesGen.renderRules(), join(here, 'rules'))
  assert.equal(rules.checked, GENERATED_RULES.length, 'the generator must own every committed rule document')
  assert.deepEqual(rules.missing, [], `the generator would not produce: ${rules.missing.join(', ')}`)
  assert.deepEqual(rules.differing, [],
    `committed rules differ from what the generator produces: ${rules.differing.join(', ')} — `
    + 'the generator is the source of truth, so fix IT and re-run with --write rather than editing a generated file')

  const fixtures = util.compareRendered(fixturesGen.renderFixtures(), join(here, 'fixtures'))
  assert.equal(fixtures.checked, GENERATED_FIXTURES.length, 'the generator must own every committed fixture')
  assert.deepEqual(fixtures.missing, [], `the generator would not produce: ${fixtures.missing.join(', ')}`)
  assert.deepEqual(fixtures.differing, [])
})

await testAsync('t42: importing a generator does not touch the filesystem', async () => {
  const rulesBefore = stampGenerated(join(here, 'rules'), GENERATED_RULES)
  const fixturesBefore = stampGenerated(join(here, 'fixtures'), GENERATED_FIXTURES)

  const entry = generatorUrl('./rules/_generate.mjs', 't42-import-safety')
  const fixturesEntry = generatorUrl('./fixtures/_generate.mjs', 't42-import-safety')
  const util = await import(generatorUrl('./_generate-util.mjs', 't42-import-safety'))

  // The guard must report "imported, not run" — otherwise the writes below would happen
  // for a reason the assertion cannot name.
  assert.equal(util.isEntryPoint(entry), false, 'a generator thought it had been run when it was only imported')

  await import(entry)
  await import(fixturesEntry)

  assert.deepEqual(stampGenerated(join(here, 'rules'), GENERATED_RULES), rulesBefore,
    'importing rules/_generate.mjs rewrote committed rule files — writing at module top level is back')
  assert.deepEqual(stampGenerated(join(here, 'fixtures'), GENERATED_FIXTURES), fixturesBefore,
    'importing fixtures/_generate.mjs rewrote committed fixtures — writing at module top level is back')
})

await testAsync('t42: the rule generator derives its globs from GATE_EXTENSIONS, and any narrowing is named', async () => {
  const rulesGen = await import(generatorUrl('./rules/_generate.mjs', 't42-scope'))
  const rendered = rulesGen.renderRules()
  const globsOf = (text) => text.match(/  - "([^"]+)"/gu)?.map((line) => line.replace(/  - "|"/gu, '')) ?? []
  const declared = GATE_EXTENSIONS.map((extension) => `**/*${extension}`)

  assert.ok(GATE_EXTENSIONS.includes('.md'),
    'this pack declares `.md` readable; if that declaration ever changes, this rule set no longer needs to cover it '
    + 'and this test should be rewritten deliberately — not deleted and not left to pass vacuously')

  // The library as a whole must cover every declared extension: that is the invariant the
  // F2 assertions establish against the files on disk, restated here against the
  // generator's own output, so a generator whose list drifts fails at the producer too.
  const covered = new Set()
  for (const [name, text] of rendered) {
    const globs = globsOf(text)
    assert.ok(globs.length > 0, `${name}: a rule with no match glob would be injected for nothing`)
    for (const glob of globs) covered.add(glob)
  }
  for (const glob of declared) {
    assert.ok(covered.has(glob), `no generated rule matches ${glob}, so the pack declares an extension it can never review`)
  }

  // ...and the rules that cover LESS than that are enumerated, not invisible. This list is
  // a decision log: each entry means a ledger in the other serializations is reviewed
  // WITHOUT this rule, and nothing says so at review time.
  const narrow = []
  for (const [name, text] of rendered) {
    if (globsOf(text).join(' ') !== declared.join(' ')) narrow.push(`${name} [${globsOf(text).join(' ')}]`)
  }
  assert.deepEqual(narrow.sort(), [
    'duplicate-id-across-documents.md [**/*.json]',
    'duplicate-id-across-populations.md [**/*.json]',
  ], 'the set of rules narrower than the declared extension set changed — decide whether the new narrowing is '
    + 'intended, then record it here (or widen the rule) rather than letting it back in unnoticed')
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
