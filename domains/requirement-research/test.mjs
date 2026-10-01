/**
 * requirement-research — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  deterministic candidate set
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey.resolve          ->  one bundle per interview session
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded extraction+review prompt
 *   P5  anchorVerifier.verify      ->  recomputed anchors; paraphrase refused
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * plus the B-family's first stage (`generator.js`) and the plugin's own tool
 * surface, because a domain that only works in isolation does not work.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 * ------------------------------------
 * 1. It never asserts "anchored" without asserting the tier. `anchored` alone is
 *    satisfiable by a verifier that guesses; the tier is what says it did not.
 * 2. It never lets P4 and P6 share a prompt. The contract validators do NOT
 *    check that, so without this assertion a domain could pass
 *    `validateDomainPackV2` while handing its reviewer its own reasoning back.
 * 3. It never asserts coverage from a call-site-reported anchor. Coverage is
 *    computed HERE from verdicts the engine produced (`anchor.verify`), so the
 *    numbers follow the input instead of following a claim about the input.
 *
 * Usage: `node domains/requirement-research/test.mjs`
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
  validateCandidateSetResult,
  validateDomainPackV2,
  validateEvidenceToolkit,
  validatePromptOutput,
  validateRuleDocument,
} from '../../lib/contracts.js'
import { bundle, coverage, createBudget, gate, report, runCritiquePanel, selectRules } from '../../lib/engine.js'
import { createNodeIo, loadDomain } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack from './index.js'
import source from './source.js'
import anchor from './anchor.js'
import evidence from './evidence.js'
import prompts from './prompts.js'
import generator from './generator.js'

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
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
  FIXTURES.set(fixture.name, fixture)
}
const fixture = (name) => {
  const value = FIXTURES.get(name)
  assert.ok(value !== undefined, `missing fixture "${name}"`)
  return value
}
const RULE_FILES = readdirSync(join(here, 'rules')).filter((file) => file.endsWith('.md')).sort()

/** Enumerate + gate one fixture. A fixture may NARROW the pack's gate, never widen it. */
function runP0P1(name) {
  const value = fixture(name)
  const context = { maxCandidates: 400, maxExcerptLines: 500 }
  const enumerated = source.enumerate(value.input.payload, context)
  const result = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: [...(pack.gate?.exclude ?? []), ...(value.gate?.exclude ?? [])],
    extensions: pack.gate?.extensions ?? null,
    maxFileBytes: value.gate?.maxFileBytes,
  })
  return { enumerated, result }
}

const byPredicate = (result) => {
  const map = {}
  for (const item of result.excluded) (map[item.predicate] ??= []).push(item.path)
  for (const key of Object.keys(map)) map[key].sort()
  return map
}

// ---------------------------------------------------------------------------
// 0. the pack itself
// ---------------------------------------------------------------------------

console.log('\nrequirement-research domain — contract v2 end-to-end')
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

test('the whole v2 gate passes once the siblings are assembled', () => {
  const problems = validateDomainPackV2({
    ...pack,
    candidateSource: source,
    anchorVerifier: anchor,
    evidenceTools: evidence,
    reviewPrompts: prompts,
    ruleLibrary: { dir: 'rules', rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['sessions/**'], text: 'y'.repeat(12), needsExpertReview: true })) },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('requirement-research')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(declared.bounded, true, 'the contract table must agree that this candidate set is bounded')
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable', 'the anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('recall-first implies the triage reviewer, and the pack declares exactly that', () => {
  assert.equal(pack.lossOrientation, 'recall-first')
  assert.equal(pack.criticism.kind, 'triage')
})

test('this is a B-family domain: the generator stage is declared, not implied', () => {
  assert.equal(pack.category, 'B')
  assert.equal(pack.generator?.kind, generator.kind)
  assert.equal(pack.generator?.anchorKind, anchor.kind, 'the extractor must hang its items on THIS domain anchor')
  assert.equal(typeof generator.generate, 'function')
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.ok(evidence.tools.length > 0)
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxLines > 0 && tool.limits.maxItems > 0 && tool.limits.maxCalls > 0, `${tool.name} must declare positive limits`)
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

test('rule selection injects only the rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'sessions-only', match: ['sessions/**'], text: 'x'.repeat(20) },
    { name: 'diffs-only', match: ['**/*.ts'], text: 'y'.repeat(20) },
  ], ['sessions/s1/u2'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['sessions-only'])
  assert.deepEqual(selected.unmapped, [])
})

test('the mandatory fixtures and this domain\'s own extra fixture are all present', () => {
  for (const name of MANDATORY_FIXTURES) assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  assert.ok(FIXTURES.has('contradictory-pair'), 'the domain needs a fixture for conflicting demands')
})

test('every fixture declares anchors with both positive and negative cases', () => {
  for (const [name, value] of FIXTURES) {
    assert.ok(value.anchors?.positive?.length > 0, `${name} needs a positive anchor case`)
    assert.ok(value.anchors?.negative?.length > 0, `${name} needs a negative anchor case`)
  }
})

// ---------------------------------------------------------------------------
// P0 / P1 — the boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — empty / all-gated-out / admitted')

test('boundary: an empty corpus produces an EMPTY candidate set and an empty gate', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  assert.equal(enumerated.candidates.length, fixture('empty').expect.candidates)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
})

test('boundary: all-gated-out enumerates candidates and the gate removes EVERY one', () => {
  const expected = fixture('all-gated-out').expect
  const { enumerated, result } = runP0P1('all-gated-out')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path).sort(), [...expected.paths].sort())
  assert.equal(result.selected.length, expected.admitted, 'the gate must admit nothing here')
  const predicates = byPredicate(result)
  for (const [predicate, paths] of Object.entries(expected.excludedByPredicate)) {
    assert.deepEqual(predicates[predicate] ?? [], [...paths].sort(), `predicate "${predicate}" mismatch`)
  }
})

test('boundary: an empty set and a fully-excluded set stay distinguishable', () => {
  const empty = runP0P1('empty')
  const gatedOut = runP0P1('all-gated-out')
  assert.equal(empty.enumerated.candidates.length, 0)
  assert.equal(empty.enumerated.excluded.length, 0)
  assert.ok(gatedOut.enumerated.candidates.length > 0)
  assert.ok(gatedOut.result.excluded.length > 0)
})

test('happy path: every utterance is admitted, and the contradictory pair survives whole', () => {
  const happy = runP0P1('happy-path')
  assert.equal(happy.enumerated.candidates.length, fixture('happy-path').expect.candidates)
  assert.equal(happy.result.selected.length, fixture('happy-path').expect.admitted)
  assert.deepEqual(happy.result.excluded, [])

  const conflict = runP0P1('contradictory-pair')
  assert.equal(conflict.result.selected.length, 2, 'a recall-first domain keeps BOTH sides of a contradiction')
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ sessions: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({}, {}), /E_INPUT_FORMAT/u)
})

test('a session with no turns is REPORTED, not silently dropped', () => {
  const enumerated = source.enumerate({ sessions: [{ id: 's1', utterances: [] }, { id: 's2', utterances: [{ t: 'T', speaker: 'participant', text: '有一句话。' }] }] }, {})
  assert.equal(enumerated.candidates.length, 1)
  assert.equal(enumerated.excluded.length, 1)
  assert.equal(enumerated.excluded[0].id, 'sessions/s1')
  assert.match(enumerated.excluded[0].reason, /没有可引用的原话/u)
})

test('candidate ids are unique, paths are gate-globable, and every locator carries its turn', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'the synthetic id must not leak into candidate.path')
    assert.match(candidate.path, /^sessions\/[a-z0-9-]+\/u\d+$/u)
    assert.equal(typeof candidate.locator.sessionId, 'string')
    assert.equal(typeof candidate.locator.utteranceIndex, 'number')
  }
})

test('redaction and withdrawal are FACTS the source reports, and the gate that acts on them', () => {
  const { enumerated } = runP0P1('all-gated-out')
  const redacted = enumerated.candidates.find((candidate) => candidate.path === 'sessions/s1/u1')
  const withdrawn = enumerated.candidates.find((candidate) => candidate.path === 'sessions/s2/u1')
  assert.equal(redacted.binary, true)
  assert.equal(withdrawn.deleted, true)
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey.resolve
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling: one bundle per interview session')

/** The key `index.js` declares, applied the way `planFor()` applies it. */
const keyed = (result) => result.selected.map((entry) => ({ ...entry, key: pack.bundleKey.resolve(entry) }))

test('the pack declares a v2 object bundleKey with a REAL resolve, not a borrowed strategy name', () => {
  assert.equal(typeof pack.bundleKey, 'object')
  assert.equal(pack.bundleKey.strategy, 'interview-session')
  assert.equal(typeof pack.bundleKey.resolve, 'function')
})

test('two utterances of the SAME session land in ONE bundle — applied, not merely declared', () => {
  const { result } = runP0P1('happy-path')
  const bundled = bundle(keyed(result))
  const keys = bundled.bundles.map((item) => item.key).sort()
  assert.deepEqual(keys, ['s1', 's2'], 'the grouping must be by session, and there are two sessions')

  const s1 = bundled.bundles.find((item) => item.key === 's1')
  assert.equal(s1.entries.length, 3, 'all three turns of s1 belong to one bounded pass')
  assert.ok(s1.entries.every((entry) => entry.path.startsWith('sessions/s1/')), 'a bundle must not mix sessions')
  assert.equal(bundled.strategy, 'keyed')
})

test('one session alone short-circuits instead of being split', () => {
  const { result } = runP0P1('contradictory-pair')
  const bundled = bundle(keyed(result))
  assert.equal(bundled.bundles.length, 1)
  assert.equal(bundled.strategy, 'short-circuit-small', 'two candidates need one bounded pass, not two')
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
  for (const entry of value.anchors?.positive ?? []) {
    test(`anchor positive [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, entry.expectStatus, entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      if (entry.expectPath !== undefined) assert.equal(verdict.path, entry.expectPath)
      if (entry.expectStart !== undefined) assert.equal(verdict.start, entry.expectStart)
      if (verdict.status === 'anchored') assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier), `tier "${verdict.tier}" is not trusted`)
    })
  }
  for (const entry of value.anchors?.negative ?? []) {
    test(`anchor negative [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, entry.expectStatus, entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.equal(verdict.start, null, 'an unanchored verdict must not carry a turn number')
      assert.equal(verdict.path, null)
      assert.equal(typeof verdict.detail, 'string', 'every unanchored verdict must explain itself')
    })
  }
  for (const entry of value.anchors?.ambiguous ?? []) {
    test(`anchor ambiguous [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, 'unanchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.ok(Array.isArray(verdict.ambiguousIn) && verdict.ambiguousIn.length > 1, 'an ambiguous verdict must list the competing locations')
      if (entry.expectAmbiguousIn !== undefined) assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
    })
  }
}

const S1_DOC = {
  path: 'sessions/s1',
  content: '每个月要花两天手工核对，最怕的是漏掉一笔。',
  times: ['2026-01-05T09:00:30Z'],
}

test('a PARAPHRASE never anchors, however obvious the intent is', () => {
  const verdict = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'sessions/s1', locator: {}, excerpt: '每个月都要手工核对两天左右。' },
    { path: 'sessions/s1', documents: [S1_DOC] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a re-worded clause, a tidied grammar and a moved comma are all different utterances', () => {
  const documents = [{ path: 'sessions/s1', content: '对不上就只能一笔一笔翻，没人知道是哪天错的。', times: ['t'] }]
  for (const excerpt of [
    '对不上只能一笔一笔翻，没人知道是哪天错的。',      // 「就」被删掉
    '对不上就只能一笔一笔地翻，没人知道是哪天错的。',  // 「地」被加上
    '对不上就只能一笔一笔翻,没人知道是哪天错的。',     // 全角逗号改成半角
  ]) {
    const verdict = anchor.verify({ kind: 'verbatim-and-timestamp', path: 'sessions/s1', locator: {}, excerpt }, { path: 'sessions/s1', documents })
    assert.equal(verdict.status, 'unanchored', `"${excerpt}" must not anchor`)
  }
})

test('whitespace is the ONLY tolerance — and it is symmetric', () => {
  const verdict = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'sessions/s1', locator: {}, excerpt: '  每个月要花两天手工核对，\n最怕的是漏掉一笔。  ' },
    { path: 'sessions/s1', documents: [{ path: 'sessions/s1', content: '每个月要花两天手工核对，最怕的是漏掉一笔。', times: ['t'] }] },
  )
  assert.equal(verdict.status, 'unanchored', 'two lines cannot match one line — the line split is part of the quote')
})

test('a wrong turn number is refused rather than repaired', () => {
  const documents = [{ path: 'sessions/s1', content: '第一句。\n第二句。', times: ['t1', 't2'] }]
  const verdict = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'sessions/s1', locator: { utteranceIndex: 9 }, excerpt: '第二句。' },
    { path: 'sessions/s1', documents },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a timestamp that contradicts the corpus is refused, and a missing one is declared un-checked', () => {
  const documents = [{ path: 'sessions/s1', content: '这句有时间戳。', times: ['2026-01-05T09:00:30Z'] }]
  const contradicted = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'sessions/s1', locator: { utteranceIndex: 1, t: '2026-01-05T08:00:00Z' }, excerpt: '这句有时间戳。' },
    { path: 'sessions/s1', documents },
  )
  assert.equal(contradicted.tier, 'locator-mismatch')

  const unchecked = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'sessions/s1', locator: { utteranceIndex: 1, t: '2026-01-05T09:00:30Z' }, excerpt: '这句有时间戳。' },
    { path: 'sessions/s1', documents: [{ path: 'sessions/s1', content: '这句有时间戳。' }] },
  )
  assert.equal(unchecked.status, 'anchored')
  assert.match(unchecked.detail, /未能核验/u, 'an un-checked timestamp must be declared un-checked, not implied verified')
})

test('a cross-session relocation must be unique — two candidates means refusal', () => {
  const documents = [
    { path: 'sessions/s1', content: '我们每周还要看一次日报。' },
    { path: 'sessions/s2', content: '我们每周还要看一次日报。' },
  ]
  const ambiguous = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'sessions/s9', locator: {}, excerpt: '我们每周还要看一次日报。' },
    { path: 'sessions/s9', documents },
  )
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['sessions/s1:1', 'sessions/s2:1'])

  const unique = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'sessions/s9', locator: {}, excerpt: '我们每周还要看一次日报。' },
    { path: 'sessions/s9', documents: [documents[0]] },
  )
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
  assert.equal(unique.path, 'sessions/s1')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'sessions/s1', locator: {}, excerpt: '第一句。' },
    { path: 'sessions/s1', content: '第一句。' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, locator: {} }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a', locator: { utteranceIndex: 0 }, excerpt: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// The B-family first stage: the constrained extractor
// ---------------------------------------------------------------------------

console.log('\nB-family — the extractor stage hangs every item on an utterance anchor')

const happyPayload = fixture('happy-path').input.payload
const CORPUS = generator.corpusDocuments(happyPayload)

test('corpusDocuments keeps ONE RAW UTTERANCE PER LINE, so a line number IS the turn number', () => {
  assert.deepEqual(CORPUS.map((document) => document.path), ['sessions/s1', 'sessions/s2'])
  assert.equal(CORPUS[0].content.split('\n').length, 3)
  assert.deepEqual(CORPUS[0].times, ['2026-01-05T09:00:00Z', '2026-01-05T09:00:30Z', '2026-01-05T09:01:10Z'])
})

const DRAFTS = [
  { id: 'd1', statement: '月度对账需要两天人工，期望自动比对', sessionId: 's1', turn: 2, t: '2026-01-05T09:00:30Z', quote: '每个月要花两天手工核对，最怕的是漏掉一笔。' },
  { id: 'd2', statement: '差异定位依赖人工逐笔翻查', sessionId: 's1', turn: 3, t: '2026-01-05T09:01:10Z', quote: '对不上就只能一笔一笔翻，没人知道是哪天错的。' },
  { id: 'd3', statement: '希望直接看到差异清单', sessionId: 's2', turn: 1, t: '2026-01-05T10:00:00Z', quote: '我们希望能直接看到差异清单，而不是再导出一遍。' },
  { id: 'd4', statement: '用户希望系统自动修复差异（转述，语料里没有）', sessionId: 's1', quote: '用户希望系统能自动修复差异记录。' },
  { id: 'd5', statement: '没有声明来源的草案', sessionId: '', quote: '凭空写的一句话。' },
  { id: 'd6', statement: '声明了句号却抄错原文（另一种拒绝）', sessionId: 's1', turn: 2, quote: '用户希望系统能自动修复差异记录。' },
]

await testAsync('the extractor emits only anchored items, and every item re-verifies independently', async () => {
  const result = generator.generate(happyPayload, { claims: DRAFTS })
  assert.deepEqual(result.items.map((item) => item.id), ['d1', 'd2', 'd3'])
  for (const item of result.items) {
    assert.equal(item.anchor.status, 'anchored')
    assert.ok(TRUSTED_ANCHOR_TIERS.includes(item.anchor.tier))
    assert.equal(item.evidenceGrade, 'verbatim-anchored')
    // The claim travels with the item, so a downstream reviewer never has to
    // trust the draft's own story about where the quote came from.
    const recheck = anchor.verify(item.claim, { documents: CORPUS })
    assert.equal(recheck.status, 'anchored', `${item.id} must survive an independent re-verification`)
    assert.equal(`${item.anchor.path}:${item.anchor.start}`, item.sourceAnchor)
  }
})

await testAsync('a draft that cannot be sourced is LISTED, never dropped and never disguised', async () => {
  const result = generator.generate(happyPayload, { claims: DRAFTS })
  assert.deepEqual(result.unsourced.map((item) => item.id), ['d4', 'd5', 'd6'])
  assert.equal(result.unsourced[0].reason, 'no-match', 'a paraphrase without a declared turn is a plain no-match, not a near-miss')
  assert.equal(result.unsourced[1].reason, 'source-missing')
  assert.equal(result.unsourced[2].reason, 'locator-mismatch', 'a declared turn the quote is not at is a CONTRADICTION, not a near-miss')
  assert.match(result.notes.join(' '), /无来源/u)
  for (const item of result.unsourced) {
    assert.ok(typeof item.detail === 'string' && item.detail.length > 0, 'an unsourced draft must say WHY')
  }
})

await testAsync('the extractor invents nothing when there are no drafts', async () => {
  const result = generator.generate(happyPayload, { claims: [] })
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.unsourced, [])
  assert.match(result.notes.join(' '), /不凭空生成需求/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['sessions/s1/u2'],
  bundle: { key: 's1', paths: ['sessions/s1/u2'], rules: ['verbatim-only'] },
  ruleText: '<rules for="sessions/s1/u2">\n原话优先：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 60 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [{ id: 'd1', path: 'sessions/s1', turn: 2, evidence: '每个月要花两天手工核对，最怕的是漏掉一笔。', message: '月度对账需要两天人工', grade: 'stated' }],
}

const P4 = prompts.review(reviewContext)
const P6 = prompts.verify(verifyContext)

test('both prompt roles return objects of strings the contract accepts', () => {
  assert.deepEqual(validatePromptOutput('review', P4), [])
  assert.deepEqual(validatePromptOutput('verify', P6), [])
})

test('P6 is NOT the P4 prompt — the assertion the validators do not make', () => {
  assert.notEqual(P6.system, P4.system, 'a P6 prompt identical to P4 deletes the independent re-check layer')
  assert.notEqual(`${P6.system}${P6.instructions}`, P4.system)
})

test('P6 cannot see the P4 work order, the rules or the budget', () => {
  assert.ok(!Object.hasOwn(verifyContext, 'ruleText'), 'P6 must not receive rule text')
  assert.doesNotMatch(P6.system, /本轮负责的候选/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /原话优先/u)
  assert.match(P4.system, /60/, 'P4 must state the search bound')
  assert.doesNotMatch(P6.system, /原话优先/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('P4 states the two-stage structure, because a B domain that forgets it is an A domain', () => {
  assert.match(P4.system, /受约束的抽取器/u)
  assert.match(P4.system, /无来源/u)
})

test('both roles repeat the quote law and the recall-first loss sentence', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /抄写原话|抄写/u)
    assert.match(text, /recall-first/u)
  }
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
})

test('flipping the orientation flips the loss sentence, so the pack cannot be silently re-pointed', () => {
  const precision = prompts.review({ ...reviewContext, orientation: 'precision-first' })
  assert.notEqual(precision.system, P4.system)
  assert.match(precision.system, /precision-first/u)
  assert.doesNotMatch(precision.system, /存疑的条目\*\*必须保留\*\*/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const DOCS = [
  { path: 'sessions/s1', content: '你好。\n每个月要花两天手工核对。\n对不上就只能一笔一笔翻。', times: ['t1', 't2', 't3'] },
  { path: 'sessions/s2', content: '每个月要花两天手工核对。', times: ['t4'] },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('quote_lookup reports EVERY hit — a quote that is not unique must not be presented as one', async () => {
  const tool = toolByName('quote_lookup')
  const result = await tool.execute({ quote: '每个月要花两天手工核对。', documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => `${item.path}:${item.turn}`), ['sessions/s1:2', 'sessions/s2:1'])
  assert.equal(result.truncated, false)
  assert.match(result.notes.join(' '), /不唯一/u)
  assert.match(result.provenance, /2 场/u)
})

await testAsync('quote_lookup caps its hits and says when it cut', async () => {
  const tool = toolByName('quote_lookup')
  const many = { path: 'sessions/big', content: Array.from({ length: 300 }, () => '同样的句子。').join('\n'), times: [] }
  const result = await tool.execute({ quote: '同样的句子。', documents: [many] }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('session_index counts coverage instead of asserting it', async () => {
  const tool = toolByName('session_index')
  const result = await tool.execute({ documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => [item.path, item.turns]), [['sessions/s1', 3], ['sessions/s2', 1]])
  assert.equal(result.items[0].from, 't1')
  assert.equal(result.items[0].to, 't3')
})

await testAsync('a request naming an absent session fails loudly with the available ones', async () => {
  const tool = toolByName('quote_lookup')
  assert.throws(() => tool.execute({ quote: 'x', sessionId: 'sessions/nope', documents: DOCS }, {}), /语料里没有/u)
})

await testAsync('a request with no documents at all is refused, not answered with "nothing found"', async () => {
  const tool = toolByName('quote_lookup')
  assert.throws(() => tool.execute({ quote: 'x' }, {}), /缺少 `documents`/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('requirement-research', 'quote_lookup'), 'adjudicate_requirement_research_evidence_quote_lookup')
})

// ---------------------------------------------------------------------------
// P4 — the prompt through the reasoner (no service => an honest 'none')
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
            structured: { findings: [{ id: 'd1', path: 'sessions/s1', evidence: '每个月要花两天手工核对，最怕的是漏掉一笔。', message: '月度对账需要两天人工', defended: true }] },
          }),
          dispose: async () => {},
        }
      },
    },
  }, { maxRounds: 2, maxFindings: 10 })

  const { result } = runP0P1('happy-path')
  const bundled = bundle(keyed(result))
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
  assert.equal(outcome.rounds, bundled.bundles.length)
  assert.ok(requests.length >= 1)
  assert.match(requests[0].prompt[0].text, /需求调研分析/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /抄写原语|抄写原话|抄写/u, 'the quote law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage and the report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

/** Anchor a candidate with the DOMAIN verifier — never with a self-reported start. */
function anchorFinding(candidate, extra = {}) {
  const sessionPath = `sessions/${candidate.locator.sessionId}`
  const verdict = anchor.verify({
    kind: anchor.kind,
    path: sessionPath,
    locator: { utteranceIndex: candidate.locator.utteranceIndex, t: candidate.locator.t ?? undefined },
    excerpt: candidate.text,
  }, { path: sessionPath, documents: CORPUS })
  assert.equal(verdict.status, 'anchored', `${candidate.path} must be anchorable by the domain verifier`)
  return {
    id: candidate.id,
    path: candidate.path,
    start: verdict.start,
    anchorTier: verdict.tier,
    severity: 'high',
    evidence: candidate.text,
    defended: true,
    ...extra,
  }
}

test('coverage is computed from engine verdicts, and the numbers follow the input', () => {
  const { result } = runP0P1('happy-path')
  const two = result.selected.slice(0, 2).map((candidate) => anchorFinding(candidate))
  const proof = coverage(result.selected.length, two)
  assert.equal(proof.total, 5)
  assert.equal(proof.reviewed, 2, 'distinct candidate paths, not finding count')
  assert.equal(proof.coverageRate, 0.4)
  assert.equal(proof.complete, false)

  const all = result.selected.map((candidate) => anchorFinding(candidate))
  assert.equal(coverage(result.selected.length, all).coverageRate, 1)
})

test('an UNANCHORED finding is excluded from the effective findings AND from coverage', () => {
  const { result } = runP0P1('happy-path')
  const first = anchorFinding(result.selected[0])
  const bare = { id: 'bare', path: 'sessions/s1/u3', severity: 'high', evidence: '看起来很可疑' }
  const effective = [first].filter((finding) => Number.isInteger(finding.start))
  assert.equal(effective.length, 1)
  assert.equal(coverage(result.selected.length, effective).reviewed, 1)
  assert.ok(!effective.includes(bare))
})

test('recall-first: incomplete coverage is reported as NOT passed, and doubt is never deleted', () => {
  const { result } = runP0P1('happy-path')
  const anchored = result.selected.slice(0, 2).map((candidate) => anchorFinding(candidate))
  const doubtful = { id: 'doubtful', path: 'sessions/s2/u2', severity: 'low', evidence: '导出之后你还会做什么？', message: '存疑：这句话是否指向一个独立诉求', defended: false }

  const panel = runCritiquePanel([...anchored, doubtful], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.equal(panel.kind, 'triage')
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['s1#u1', 's1#u2', 'doubtful'], 'a recall-first panel keeps the doubtful item')
  assert.deepEqual(panel.dropped, [])

  const proof = coverage(result.selected.length, panel.kept, { requireComplete: true })
  assert.equal(proof.complete, false, 'coverage is incomplete and must say so')
  assert.equal(proof.required, true)

  const built = report({
    domain: pack,
    target: 'fixture happy-path',
    scope: { admitted: result.selected.length, excluded: 0, bundles: 2 },
    findings: panel.kept,
    coverageProof: proof,
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'requirement-research')
  assert.equal(built.lossOrientation, 'recall-first')
  assert.equal(built.criticismKind, 'triage')
  assert.equal(built.coverage.complete, false)
  assert.ok(built.findings.some((finding) => finding.id === 'doubtful'), 'the doubtful item must survive into the report')
  assert.equal(built.generatedAt, null, 'a deterministic engine must not stamp wall-clock time')
})

test('only a POSITIVELY DISPROVED finding is dropped under recall-first', () => {
  const panel = runCritiquePanel([
    { id: 'kept', severity: 'low', evidence: 'x', defended: false },
    { id: 'disproved', severity: 'high', evidence: 'y', defended: true, disproved: true },
  ], { orientation: 'recall-first', kind: 'triage' })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['kept'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['disproved'])
})

// ---------------------------------------------------------------------------
// The domain as loaded from disk
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: 'requirement-research', dir: 'domains/requirement-research' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'verbatim-quotes')
  assert.equal(assembled.anchorVerifier.kind, 'verbatim-and-timestamp')
  assert.equal(assembled.evidenceTools.tools.length, evidence.tools.length)
  assert.equal(typeof assembled.reviewPrompts.review, 'function')
  assert.equal(typeof assembled.reviewPrompts.verify, 'function')
  assert.ok(assembled.ruleLibrary.rules.length >= MIN_RULES_PER_DOMAIN)
  assert.deepEqual([...assembled.fixtures].sort(), FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')).sort())
  for (const file of ['index.js', 'source.js', 'anchor.js', 'evidence.js', 'prompts.js']) {
    assert.ok(loaded.files.includes(file), `loader must report it loaded ${file}`)
  }
})

// ---------------------------------------------------------------------------
// Through the plugin's own tool surface
// ---------------------------------------------------------------------------

console.log('\nthrough the plugin — P0 -> P3 over a fixture')

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

await testAsync('adjudication_plan consumes the fixture corpus through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'requirement-research',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'verbatim-quotes')
  assert.equal(plan.candidateSet.inputFormat, 'interview-corpus')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the v2 object form must be applied, not merely declared')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['s1', 's2'])
  assert.equal(plan.bundles.find((item) => item.key === 's1').paths.length, 3)
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'requirement-research',
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
    domain: 'requirement-research',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'sessions/s1/u1': 'binary',
    'sessions/s2/u1': 'deleted',
    'sessions/retracted/u1': 'user-exclude',
  })
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /排除 3 项/u)
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'requirement-research' }, {})
  const listed = await ctx.__tools.get('adjudicate_requirement_research_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand, and deactivation removes them', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'requirement-research' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    const name = evidenceToolName('requirement-research', tool.name)
    assert.ok(ctx.__tools.has(name), `${name} must be registered on activation`)
  }
  const quoteTool = ctx.__tools.get(evidenceToolName('requirement-research', 'quote_lookup'))
  const result = await quoteTool.execute({ quote: '每个月要花两天手工核对。', documents: DOCS }, {})
  assert.equal(result.domain, 'requirement-research')
  assert.equal(result.items.length, 2)

  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'requirement-research' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('requirement-research', tool.name)), false)
  }
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'requirement-research',
    target: 'replacement probe',
    candidates: [
      { path: 'sessions/s1/u1', meta: { sessionId: 's1' } },
      { path: 'sessions/s1/u2', meta: { sessionId: 's1' } },
      { path: 'sessions/s2/u1', meta: { sessionId: 's2' } },
      { path: 'sessions/s2/u2', meta: { sessionId: 's2' } },
    ],
  }, {})
  // v1 declared the string 'interview' (not activated by default); v2 declares an
  // object with a resolver, which always applies.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['s1', 's2'])
  assert.ok(plan.bundles.every((item) => item.paths.length === 2), 'two candidates per session in ONE bundle each')

  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19, 'replacement must not change the domain count')
  assert.ok(listed.directory.replaced.includes('requirement-research'))
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log(`\nfailed: ${failedTitles.join(' | ')}`)
  process.exitCode = 1
}
