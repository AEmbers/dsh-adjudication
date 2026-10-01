/**
 * product-planning — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Pipeline: P0 enumerate -> P1 gate -> P2 bundleKey.resolve -> P3 rules ->
 * P4 review prompt -> P5 anchor -> P6 verify prompt -> P7 evidence tools, plus
 * the B-family's first stage (`generator.js`) and the plugin's own tool surface.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 * ------------------------------------
 * 1. It never asserts "anchored" without asserting the tier.
 * 2. It never lets P4 and P6 share a prompt (`assert.notEqual(p6.system,
 *    p4.system)`) — the validators do not check that, so this file must.
 * 3. It never feeds a self-reported anchor into coverage. Every finding used for
 *    a coverage assertion is anchored by THIS domain's `anchor.verify` first, so
 *    the numbers follow the input instead of following a claim about the input.
 *
 * Usage: `node domains/product-planning/test.mjs`
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

function runP0P1(name) {
  const value = fixture(name)
  const enumerated = source.enumerate(value.input.payload, { maxCandidates: 400, maxExcerptLines: 500 })
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

console.log('\nproduct-planning domain — contract v2 end-to-end')
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
    ruleLibrary: { dir: 'rules', rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['plans/**'], text: 'y'.repeat(12), needsExpertReview: true })) },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('product-planning')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(declared.bounded, true)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable')
})

test('precision-first implies the fact-checker reviewer, and the pack declares exactly that', () => {
  assert.equal(pack.lossOrientation, 'precision-first')
  assert.equal(pack.criticism.kind, 'fact-checker')
})

test('this is a B-family domain: the generator stage is declared and hangs on THIS anchor', () => {
  assert.equal(pack.category, 'B')
  assert.equal(pack.generator?.kind, generator.kind)
  assert.equal(pack.generator?.anchorKind, anchor.kind)
  assert.equal(typeof generator.generate, 'function')
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.equal(evidence.tools.length, 2)
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxItems > 0 && tool.limits.maxCalls > 0, `${tool.name} must declare positive limits`)
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

test('rule selection maps plan paths to the traceability rules and reports unmapped ones', () => {
  const selected = selectRules([
    { name: 'edge-rule', match: ['plans/*/serves/**'], text: 'x'.repeat(20) },
    { name: 'doc-rule', match: ['**/*.md'], text: 'y'.repeat(20) },
  ], ['plans/plan-recon/serves/req-ledger', 'notes/readme.md'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['edge-rule', 'doc-rule'])
  assert.deepEqual(selected.unmapped, [])
})

test('the mandatory fixtures and this domain\'s own extra fixture are all present', () => {
  for (const name of MANDATORY_FIXTURES) assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  assert.ok(FIXTURES.has('orphan-both-sides'))
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

test('boundary: an empty registry and plan produce an EMPTY candidate set and an empty gate', () => {
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

test('happy path: every edge is admitted and the orphan fixture keeps its two sides', () => {
  const happy = runP0P1('happy-path')
  assert.equal(happy.enumerated.candidates.length, fixture('happy-path').expect.candidates)
  assert.equal(happy.result.selected.length, fixture('happy-path').expect.admitted)
  assert.deepEqual(happy.result.excluded, [])

  const orphans = runP0P1('orphan-both-sides')
  const kinds = orphans.enumerated.candidates.map((candidate) => candidate.meta.kind).sort()
  assert.deepEqual(kinds, ['orphan-plan', 'orphan-requirement', 'orphan-requirement', 'requirement-plan-link'])
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ requirements: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ plans: [] }, {}), /E_INPUT_FORMAT/u)
})

test('a link to a requirement that does not exist is REPORTED as a broken trace', () => {
  const enumerated = source.enumerate({
    requirements: [{ id: 'r1', title: '存在的需求', status: 'confirmed' }],
    plans: [{ id: 'p1', title: '方案', serves: ['r1', 'ghost'] }],
  }, {})
  assert.equal(enumerated.candidates.length, 1)
  assert.equal(enumerated.excluded.length, 1)
  assert.match(enumerated.excluded[0].reason, /不存在的需求 "ghost"/u)
})

test('candidate ids are unique, paths are gate-globable, and the metric facts travel with the edge', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u)
    assert.match(candidate.path, /^(plans|requirements)\/[a-z0-9-]+\/(serves\/[a-z0-9-]+|orphan)$/u)
    assert.equal(typeof candidate.locator.planId, 'string')
    assert.equal(typeof candidate.meta.metricHasBaseline, 'boolean')
  }
  const noMetric = enumerated.candidates.find((candidate) => candidate.path === 'plans/plan-audit/serves/req-audit-trail')
  assert.equal(noMetric.meta.metricName, '可追溯覆盖率')
  assert.equal(noMetric.meta.metricHasBaseline, true)
})

test('the `too-large` predicate is the engine\'s, and the pack does not have to restate it', () => {
  const result = gate([{ path: 'plans/p1/serves/r1', bytes: 4096 }], { exclude: pack.gate.exclude, maxFileBytes: 1024 })
  assert.deepEqual(result.selected, [])
  assert.equal(result.excluded[0].predicate, 'too-large')
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey.resolve
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling: one bundle per plan')

const keyed = (result) => result.selected.map((entry) => ({ ...entry, key: pack.bundleKey.resolve(entry) }))

test('the pack declares a v2 object bundleKey with a REAL resolve, not a borrowed strategy name', () => {
  assert.equal(typeof pack.bundleKey, 'object')
  assert.equal(pack.bundleKey.strategy, 'plan-item')
  assert.equal(typeof pack.bundleKey.resolve, 'function')
})

test('two edges of the SAME plan land in ONE bundle — applied, not merely declared', () => {
  const { result } = runP0P1('happy-path')
  const bundled = bundle(keyed(result))
  assert.deepEqual(bundled.bundles.map((item) => item.key).sort(), ['plan-audit', 'plan-diff', 'plan-recon'])
  const diff = bundled.bundles.find((item) => item.key === 'plan-diff')
  assert.equal(diff.entries.length, 2, 'plan-diff serves two requirements and must be reviewed in one pass')
  assert.ok(diff.entries.every((entry) => entry.locator.planId === 'plan-diff'), 'a bundle must not mix plans')
  assert.equal(bundled.strategy, 'keyed')
})

test('an orphan requirement falls back to its own key instead of joining a plan', () => {
  const { result } = runP0P1('orphan-both-sides')
  const orphan = result.selected.find((entry) => entry.meta.kind === 'orphan-requirement')
  assert.equal(pack.bundleKey.resolve(orphan), 'requirements/req-nobody')
  const byPlan = result.selected.find((entry) => entry.meta.kind === 'requirement-plan-link')
  assert.equal(pack.bundleKey.resolve(byPlan), 'plan-serves')

  // Three admitted candidates are fewer than `BUNDLE_DEFAULTS.minFiles`, so the
  // engine short-circuits them into ONE bounded pass rather than three.
  const bundled = bundle(keyed(result))
  assert.equal(bundled.bundles.length, 1)
  assert.equal(bundled.strategy, 'short-circuit-small')
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
      assert.equal(verdict.start, null)
      assert.equal(verdict.path, null)
      assert.equal(typeof verdict.detail, 'string')
    })
  }
  for (const entry of value.anchors?.ambiguous ?? []) {
    test(`anchor ambiguous [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, 'unanchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.ok(verdict.ambiguousIn.length > 1)
      if (entry.expectAmbiguousIn !== undefined) assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
    })
  }
}

const REQ_DOCS = [
  { path: 'requirements/req-ledger', content: '月度对账需要两天人工，期望自动比对', metrics: [] },
  { path: 'plans/plan-recon', content: '自动对账引擎', metrics: ['对账时长'] },
]

test('a PARAPHRASE of a requirement never anchors', () => {
  const verdict = anchor.verify(
    { kind: anchor.kind, path: 'requirements/req-ledger', locator: {}, excerpt: '月度对账需要两天人工处理，希望自动比对' },
    { path: 'requirements/req-ledger', documents: REQ_DOCS },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a metric nobody declared is UNANCHORED — "提升 X%" without a definition is not a goal', () => {
  for (const metricName of ['转化率', '对账时长 ']) {
    const verdict = anchor.verify(
      { kind: anchor.kind, path: 'requirements/req-ledger', locator: { metricName }, excerpt: '月度对账需要两天人工，期望自动比对' },
      { path: 'requirements/req-ledger', documents: REQ_DOCS },
    )
    assert.equal(verdict.status, 'unanchored', `metric "${metricName}" must not anchor`)
    assert.equal(verdict.tier, 'no-match')
    assert.match(verdict.detail, /没有声明/u)
  }
})

test('a metric declared by ANOTHER plan does not count for this one', () => {
  const verdict = anchor.verify(
    { kind: anchor.kind, path: 'requirements/req-ledger', locator: { metricName: '对账时长', planId: 'plans/plan-diff' }, excerpt: '月度对账需要两天人工，期望自动比对' },
    { path: 'requirements/req-ledger', documents: [...REQ_DOCS, { path: 'plans/plan-diff', content: '差异清单视图', metrics: ['差异定位时长'] }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /不是方案 "plans\/plan-diff" 声明的/u)
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { kind: anchor.kind, path: 'requirements/req-ledger', locator: { startLine: 99 }, excerpt: '月度对账需要两天人工，期望自动比对' },
    { path: 'requirements/req-ledger', documents: REQ_DOCS },
  )
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a cross-document relocation must be unique — two requirements with the same text means refusal', () => {
  const documents = [
    { path: 'requirements/req-a', content: '重复的需求原文', metrics: [] },
    { path: 'requirements/req-b', content: '重复的需求原文', metrics: [] },
  ]
  const ambiguous = anchor.verify(
    { kind: anchor.kind, path: 'requirements/req-gone', locator: {}, excerpt: '重复的需求原文' },
    { path: 'requirements/req-gone', documents },
  )
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['requirements/req-a:1', 'requirements/req-b:1'])

  const unique = anchor.verify(
    { kind: anchor.kind, path: 'requirements/req-gone', locator: {}, excerpt: '重复的需求原文' },
    { path: 'requirements/req-gone', documents: [documents[0]] },
  )
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'verbatim-and-timestamp', path: 'requirements/req-ledger', locator: {}, excerpt: 'x' },
    { path: 'requirements/req-ledger', content: 'x' },
  )
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: 'a', locator: { startLine: 0 }, excerpt: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: anchor.kind, path: '' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// The B-family first stage: the constrained planner
// ---------------------------------------------------------------------------

console.log('\nB-family — the planner stage refuses items it cannot trace')

const HAPPY = fixture('happy-path').input.payload
const REGISTRY = generator.registryDocuments(HAPPY)
const DRAFTS = [
  { id: 'i1', statement: '把对账从两天压到半天', requirementId: 'req-ledger', planId: 'plan-recon', metricName: '对账时长', quote: '月度对账需要两天人工，期望自动比对' },
  { id: 'i2', statement: '提供差异清单视图', requirementId: 'req-diff-list', planId: 'plan-diff', quote: '希望直接看到差异清单，而不是再导出一遍' },
  { id: 'i3', statement: '顺手加一个暗色主题（无需求来源）', quote: '用户喜欢暗色主题' },
  { id: 'i4', statement: '做一个不存在的需求', requirementId: 'req-ghost', quote: '这条需求从来不存在' },
  { id: 'i5', statement: '需求对了但原文是转述的', requirementId: 'req-audit-trail', planId: 'plan-audit', metricName: '可追溯覆盖率', quote: '每次调整都需要有操作记录' },
  { id: 'i6', statement: '需求与原文都对，但指标没人声明', requirementId: 'req-audit-trail', planId: 'plan-audit', metricName: '审计满意度', quote: '每次调整都要留下可追溯的操作记录' },
]

test('registryDocuments gives plans their declared metric vocabulary and requirements none', () => {
  const recon = REGISTRY.find((document) => document.path === 'plans/plan-recon')
  const ledger = REGISTRY.find((document) => document.path === 'requirements/req-ledger')
  assert.deepEqual(recon.metrics, ['对账时长'])
  assert.deepEqual(ledger.metrics, [])
  assert.equal(ledger.content, '月度对账需要两天人工，期望自动比对')
})

await testAsync('the planner emits only anchored items, and every item re-verifies independently', async () => {
  const result = generator.generate(HAPPY, { drafts: DRAFTS })
  assert.deepEqual(result.items.map((item) => item.id), ['i1', 'i2'])
  for (const item of result.items) {
    assert.equal(item.anchor.status, 'anchored')
    assert.ok(TRUSTED_ANCHOR_TIERS.includes(item.anchor.tier))
    assert.equal(`${item.anchor.path}:${item.anchor.start}`, item.sourceAnchor)
    const recheck = anchor.verify(item.claim, { documents: REGISTRY })
    assert.equal(recheck.status, 'anchored', `${item.id} must survive an independent re-verification`)
  }
})

await testAsync('scope creep, broken traces and unverifiable quotes are LISTED separately, never dropped', async () => {
  const result = generator.generate(HAPPY, { drafts: DRAFTS })
  assert.deepEqual(result.unsourced.map((item) => item.id), ['i3', 'i4', 'i5', 'i6'])
  assert.deepEqual(result.unsourced.map((item) => item.kind), ['scope-creep', 'broken-trace', 'unverifiable', 'unverifiable'])
  assert.equal(result.unsourced[0].reason, 'no-requirement')
  assert.equal(result.unsourced[1].reason, 'unknown-requirement')
  assert.equal(result.unsourced[2].reason, 'no-match', 'a paraphrase is a no-match')
  assert.equal(result.unsourced[3].reason, 'no-match', 'an undeclared metric is a no-match too — with a different detail')
  assert.match(result.unsourced[3].detail, /指标/u)
  assert.match(result.notes.join(' '), /无来源/u)
})

await testAsync('the planner invents nothing when there are no drafts', async () => {
  const result = generator.generate(HAPPY, { drafts: [] })
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.unsourced, [])
  assert.match(result.notes.join(' '), /不凭空生成方案项/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['plans/plan-recon/serves/req-ledger'],
  bundle: { key: 'plan-recon', paths: ['plans/plan-recon/serves/req-ledger'], rules: ['traceability'] },
  ruleText: '<rules for="plans/plan-recon/serves/req-ledger">\n可追溯性：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 40 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [{ id: 'i1', requirementId: 'req-ledger', evidence: '月度对账需要两天人工，期望自动比对', metricName: '对账时长', baseline: 2, target: 0.5, window: '2026 Q2', message: '把对账压到半天' }],
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
  assert.doesNotMatch(P6.system, /本轮负责的边/u)
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /可追溯性/u)
  assert.match(P4.system, /40/)
  assert.doesNotMatch(P6.system, /可追溯性/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('P4 states the two-stage structure, because a B domain that forgets it is an A domain', () => {
  assert.match(P4.system, /受约束的编排器/u)
  assert.match(P4.system, /无来源/u)
})

test('P6 states the deletion-default that precision-first implies', () => {
  assert.match(P6.system, /precision-first/u)
  assert.match(P6.system, /删除是默认/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
})

test('flipping the orientation flips the loss sentence', () => {
  const recall = prompts.verify({ ...verifyContext, orientation: 'recall-first' })
  assert.notEqual(recall.system, P6.system)
  assert.match(recall.system, /recall-first/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const ORPHAN_ARGS = {
  requirements: [
    { id: 'r1', title: '有人接', status: 'confirmed' },
    { id: 'r2', title: '没人接', status: 'confirmed' },
  ],
  plans: [
    { id: 'p1', title: '接 r1', serves: ['r1'], metric: { name: 'M1', baseline: 1, target: 2, window: 'Q1' } },
    { id: 'p2', title: '谁也不接', serves: [], metric: null },
    { id: 'p3', title: '接一个幽灵', serves: ['ghost'], metric: null },
  ],
}
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('orphan_scan finds BOTH sides and the broken link, each labelled', async () => {
  const result = await toolByName('orphan_scan').execute(ORPHAN_ARGS, {})
  const byKind = {}
  for (const item of result.items) (byKind[item.kind] ??= []).push(item.id)
  assert.deepEqual(byKind['orphan-requirement'], ['r2'])
  assert.deepEqual(byKind['orphan-plan'], ['p2'])
  assert.deepEqual(byKind['broken-link'], ['p3'])
  assert.equal(result.truncated, false)
  assert.match(result.provenance, /2 条需求 \/ 3 个方案/u)
})

await testAsync('orphan_scan caps its item count and says when it cut', async () => {
  const many = {
    requirements: Array.from({ length: 80 }, (_, index) => ({ id: `r${index}`, title: 'x', status: 'confirmed' })),
    plans: [],
  }
  const result = await toolByName('orphan_scan').execute(many, {})
  assert.equal(result.items.length, toolByName('orphan_scan').limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('orphan_scan refuses an empty request instead of answering "no orphans"', async () => {
  assert.throws(() => toolByName('orphan_scan').execute({ requirements: [], plans: [] }, {}), /E_INPUT_FORMAT/u)
})

await testAsync('metric_lookup exposes missing baselines, because "提升 X%" without one is not a goal', async () => {
  const result = await toolByName('metric_lookup').execute({
    plans: [
      { id: 'p1', serves: ['r1'], metric: { name: 'M1', baseline: 2, target: 0.5, window: 'Q2' } },
      { id: 'p2', serves: ['r1'], metric: { name: 'M2', target: 0.5, window: 'Q2' } },
      { id: 'p3', serves: ['r1'], metric: null },
    ],
  }, {})
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0].missingBaseline, false)
  assert.equal(result.items[1].missingBaseline, true, 'a metric with no baseline must be flagged')
  assert.equal(result.items[2].missingBaseline, true)
  assert.equal(result.items[2].target, null)
})

await testAsync('metric_lookup narrows to one requirement when asked', async () => {
  const result = await toolByName('metric_lookup').execute({
    plans: [
      { id: 'p1', serves: ['r1'], metric: { name: 'M1', baseline: 1, target: 2, window: 'Q1' } },
      { id: 'p2', serves: ['r2'], metric: { name: 'M2', baseline: 1, target: 2, window: 'Q1' } },
    ],
    requirementId: 'r2',
  }, {})
  assert.deepEqual(result.items.map((item) => item.planId), ['p2'])
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('product-planning', 'orphan_scan'), 'adjudicate_product_planning_evidence_orphan_scan')
})

// ---------------------------------------------------------------------------
// P4 — the prompt through the reasoner
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
            structured: { findings: [{ id: 'i1', requirementId: 'req-ledger', path: 'plans/plan-recon/serves/req-ledger', evidence: '月度对账需要两天人工，期望自动比对', message: '把对账压到半天', defended: true }] },
          }),
          dispose: async () => {},
        }
      },
    },
  }, { maxRounds: 3, maxFindings: 10 })

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
  assert.match(requests[0].prompt[0].text, /产品规划经理/u)
  assert.match(requests[0].prompt[0].text, /可追溯铁律/u)
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage and the report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

/** Anchor an edge with the DOMAIN verifier — never with a self-reported line. */
function anchorFinding(candidate, extra = {}) {
  const requirement = HAPPY.requirements.find((entry) => entry.id === candidate.locator.requirementId)
  const verdict = anchor.verify({
    kind: anchor.kind,
    path: `requirements/${candidate.locator.requirementId}`,
    locator: { requirementId: candidate.locator.requirementId, metricName: candidate.meta.metricName ?? undefined },
    excerpt: requirement.title,
  }, { documents: REGISTRY })
  assert.equal(verdict.status, 'anchored', `${candidate.path} must be anchorable by the domain verifier`)
  return { id: candidate.id, path: candidate.path, start: verdict.start, anchorTier: verdict.tier, severity: 'high', evidence: requirement.title, defended: true, ...extra }
}

test('coverage is computed from engine verdicts, and the numbers follow the input', () => {
  const { result } = runP0P1('happy-path')
  const two = result.selected.slice(0, 2).map((candidate) => anchorFinding(candidate))
  const proof = coverage(result.selected.length, two)
  assert.equal(proof.total, 4)
  assert.equal(proof.reviewed, 2)
  assert.equal(proof.coverageRate, 0.5)
  assert.equal(proof.complete, false)

  const all = result.selected.map((candidate) => anchorFinding(candidate))
  assert.equal(coverage(result.selected.length, all).coverageRate, 1)
  assert.equal(coverage(result.selected.length, all).complete, true)
})

test('precision-first drops what it cannot prove and keeps what it can', () => {
  const { result } = runP0P1('happy-path')
  const proven = anchorFinding(result.selected[0])
  const bare = { id: 'bare', path: 'plans/plan-recon/serves/req-ledger', severity: 'high', evidence: '感觉不太对', defended: false }
  const panel = runCritiquePanel([proven, bare], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), [proven.id])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['bare'])
  assert.equal(panel.kind, 'fact-checker')
})

test('an UNANCHORED finding is excluded from the effective findings AND from coverage', () => {
  const { result } = runP0P1('happy-path')
  const anchored = anchorFinding(result.selected[0])
  const unanchored = { id: 'ghost', path: 'requirements/req-nothing/orphan', severity: 'high', evidence: '这条需求不存在' }
  const effective = [anchored, unanchored].filter((finding) => Number.isInteger(finding.start) && finding.start > 0)
  assert.equal(effective.length, 1)
  assert.equal(coverage(result.selected.length, effective).reviewed, 1)
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const { result } = runP0P1('happy-path')
  const proven = anchorFinding(result.selected[0])
  const panel = runCritiquePanel([proven], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture happy-path',
    scope: { admitted: 4, excluded: 0, bundles: 3 },
    findings: panel.kept,
    coverageProof: coverage(4, panel.kept),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'product-planning')
  assert.equal(built.lossOrientation, 'precision-first')
  assert.equal(built.criticismKind, 'fact-checker')
  assert.equal(built.coverage.total, 4)
  assert.equal(built.coverage.reviewed, 1)
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
  const loaded = await loadDomain(io, { id: 'product-planning', dir: 'domains/product-planning' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'requirement-to-plan-links')
  assert.equal(assembled.anchorVerifier.kind, 'requirement-and-metric')
  assert.equal(assembled.evidenceTools.tools.length, evidence.tools.length)
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

await testAsync('adjudication_plan consumes the fixture registry through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'product-planning',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'requirement-to-plan-links')
  assert.equal(plan.candidateSet.inputFormat, 'requirement-registry-and-plan')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the v2 object form must be applied, not merely declared')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['plan-audit', 'plan-diff', 'plan-recon'])
  assert.equal(plan.bundles.find((item) => item.key === 'plan-diff').paths.length, 2)
  assert.equal(plan.criticism.kind, 'fact-checker')
  assert.match(plan.summary, /复核者：fact-checker/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'product-planning',
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
    domain: 'product-planning',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'plans/plan-attach/orphan': 'binary',
    'plans/plan-draft/serves/req-draft': 'deleted',
    'plans/plan-shadow/serves/req-shadow': 'deleted',
    'requirements/req-unserved/orphan': 'deleted',
  })
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /排除 4 项/u)
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'product-planning' }, {})
  const listed = await ctx.__tools.get('adjudicate_product_planning_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand, and deactivation removes them', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'product-planning' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName('product-planning', tool.name)), `${tool.name} must be registered on activation`)
  }
  const orphanTool = ctx.__tools.get(evidenceToolName('product-planning', 'orphan_scan'))
  const result = await orphanTool.execute(ORPHAN_ARGS, {})
  assert.equal(result.domain, 'product-planning')
  assert.equal(result.items.length, 3)

  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'product-planning' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('product-planning', tool.name)), false)
  }
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'product-planning',
    target: 'replacement probe',
    candidates: [
      { path: 'plans/p1/serves/r1', meta: { planId: 'p1' } },
      { path: 'plans/p1/serves/r2', meta: { planId: 'p1' } },
      { path: 'plans/p2/serves/r3', meta: { planId: 'p2' } },
      { path: 'plans/p2/serves/r4', meta: { planId: 'p2' } },
    ],
  }, {})
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['p1', 'p2'])
  assert.ok(plan.bundles.every((item) => item.paths.length === 2), 'two edges of the same plan in ONE bundle each')

  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19, 'replacement must not change the domain count')
  assert.ok(listed.directory.replaced.includes('product-planning'))
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
