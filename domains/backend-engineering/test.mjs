/**
 * backend-engineering — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Pipeline: P0 enumerate -> P1 gate -> P2 bundleKey -> P3 rules -> P4 review
 * prompt -> P5 anchor -> P6 verify prompt -> P7 evidence tools, then the same
 * domain through the plugin's own tool surface.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 * ------------------------------------
 * 1. It never asserts "anchored" without asserting the tier.
 * 2. It never lets P4 and P6 share a prompt (`assert.notEqual(p6.system,
 *    p4.system)`) — the validators do not check that, so this file must.
 * 3. It never feeds a self-reported anchor into coverage: every coverage number
 *    below is computed from verdicts THIS domain's verifier produced.
 *
 * It also asserts the REUSE the domain is built on: this diff domain must use
 * code-review's parser, anchor and evidence tools BY IDENTITY. A copy would look
 * correct in review and drift the first time the reference was fixed.
 *
 * Usage: `node domains/backend-engineering/test.mjs`
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
  resolveBundleKey,
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

import codeReviewAnchor from '../code-review/anchor.js'
import codeReviewSource from '../code-review/source.js'
import codeReviewEvidence from '../code-review/evidence.js'

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

/**
 * Apply the pack's `bundleKey` exactly the way `planFor()` does — and assert it
 * APPLIED, because a declared-but-ineffective grouping is the failure mode the
 * v2 object form exists to remove.
 */
const keyed = (selected) => selected.map((entry) => {
  const resolution = resolveBundleKey(pack, entry, {})
  assert.equal(resolution.applied, true, `bundleKey must apply to ${entry.path}`)
  assert.equal(resolution.source, 'derived')
  return { ...entry, key: resolution.key }
})

// ---------------------------------------------------------------------------
// 0. the pack itself
// ---------------------------------------------------------------------------

console.log('\nbackend-engineering domain — contract v2 end-to-end')
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
    ruleLibrary: { dir: 'rules', rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['**/*'], text: 'y'.repeat(12), needsExpertReview: true })) },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('backend-engineering')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(declared.bounded, true)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, 'diff-line')
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable')
})

test('precision-first implies the fact-checker reviewer, and the pack declares exactly that', () => {
  assert.equal(pack.lossOrientation, 'precision-first')
  assert.equal(pack.criticism.kind, 'fact-checker')
})

// --- the reuse this domain is built on -------------------------------------

test('the anchor verifier is code-review\'s, object-identical — not a second implementation', () => {
  assert.equal(anchor, codeReviewAnchor, 'anchor.js must re-export the reference verifier')
  assert.equal(anchor.verify, codeReviewAnchor.verify, 'and the verify function must be the same function')
  assert.equal(anchor.reusedFrom ?? anchor.REUSED_FROM, undefined, 'a stray field would mean a wrapper, not a re-export')
})

test('the candidate parser is code-review\'s — the domain only adds enrichment on top', () => {
  assert.equal(source.parseUnifiedDiff, codeReviewSource.parseUnifiedDiff)
  assert.equal(source.hunkLineCounts, codeReviewSource.hunkLineCounts)
  assert.equal(source.hunkNewSpan, codeReviewSource.hunkNewSpan)
})

test('the three bounded diff tools are code-review\'s, by function identity', () => {
  for (let index = 0; index < codeReviewEvidence.tools.length; index += 1) {
    assert.equal(evidence.tools[index].name, codeReviewEvidence.tools[index].name)
    assert.equal(evidence.tools[index].execute, codeReviewEvidence.tools[index].execute,
      `${evidence.tools[index].name} must be reused by reference, not copied`)
  }
  assert.equal(evidence.tools.length, codeReviewEvidence.tools.length + 1, 'exactly one tool is this domain\'s own')
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
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

test('the rule library dispatches by path, so a bundle only carries rules that apply to it', () => {
  const all = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = /^name:\s*(.+)$/mu.exec(text)[1].trim()
    const match = [...text.matchAll(/^ {2}- (.+)$/gmu)].map((entry) => entry[1].trim())
    return { name, match, text: 'x'.repeat(20) }
  })
  const selected = selectRules(all, ['api/handler.go'])
  assert.ok(selected.injected.length > 0, 'the probe path must match at least one rule')
  assert.ok(selected.injected.length < all.length, 'and must NOT match every rule — dispatch would be decoration')
  assert.ok(selected.injected.some((rule) => rule.name === 'api-compatibility'), `the probe path must select "api-compatibility"`)
  assert.ok(!selected.injected.some((rule) => rule.name === 'migration-safety'), 'an unrelated rule must not be injected')
})

test('the mandatory fixtures and this domain\'s own extra fixture are all present', () => {
  for (const name of MANDATORY_FIXTURES) assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  assert.ok(FIXTURES.has('proto-field-removed'))
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

test('boundary: an empty diff produces an EMPTY candidate set and an empty gate', () => {
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
    if (paths.length === 0) continue
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

test('happy path: every hunk is admitted, one candidate per (file, hunk)', () => {
  const happy = runP0P1('happy-path')
  assert.equal(happy.enumerated.candidates.length, fixture('happy-path').expect.candidates)
  assert.equal(happy.result.selected.length, fixture('happy-path').expect.admitted)
  assert.deepEqual(happy.result.excluded, [])
  for (const candidate of happy.enumerated.candidates) {
    assert.equal(typeof candidate.locator.hunkIndex, 'number')
    assert.equal(typeof candidate.locator.startLine, 'number')
    assert.match(candidate.id, /#hunk-\d+$/u)
  }
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ diff: 42 }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ diff: '', serviceMap: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ diff: '' }, {}))
})

test('candidate ids are unique and `path` stays a gate-globable file path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'a synthetic id must never leak into candidate.path')
  }
})


test('the serviceMap is enrichment on top of the reused parser, and "unknown" is reported as unknown', () => {
  const payload = fixture('happy-path').input.payload
  const mapped = source.enumerate(payload, {})
  assert.ok(mapped.candidates.every((candidate) => typeof candidate.meta.service === 'string'))
  assert.deepEqual([...new Set(mapped.candidates.map((candidate) => candidate.meta.service))].sort(), ['order-api', 'order-db', 'order-worker'])
  assert.deepEqual(mapped.notes, [])

  const unmapped = source.enumerate({ diff: payload.diff }, {})
  assert.ok(unmapped.candidates.every((candidate) => candidate.meta.service === null))
  assert.match(unmapped.notes.join(' '), /没有 serviceMap 归属/u)
  assert.doesNotMatch(unmapped.notes.join(' '), /不影响/u, 'an unknown boundary must never be reported as "no impact"')
})

test('the extra fixture: a removed proto field is enumerated as an ordinary hunk', () => {
  const { enumerated, result } = runP0P1('proto-field-removed')
  assert.equal(enumerated.candidates.length, 1)
  assert.equal(result.selected.length, 1)
  assert.equal(result.selected[0].path, 'proto/ledger.proto')
})


// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling')

test('the pack reuses code-review\'s grouping口径: { strategy: directory, depth: 1 }', () => {
  assert.deepEqual(pack.bundleKey, { strategy: 'directory', depth: 1 })
})

test('the multi-directory change really splits, and two files of ONE directory share a bundle', () => {
  const { result } = runP0P1('happy-path')
  const bundled = bundle(keyed(result.selected))
  assert.equal(bundled.strategy, 'keyed')
  assert.deepEqual(bundled.bundles.map((item) => item.key).sort(), ['api', 'db', 'worker'])
  for (const item of bundled.bundles) {
    assert.ok(item.entries.length >= 1)
    for (const entry of item.entries) {
      assert.equal(entry.path.split('/')[0], item.key, 'a bundle must not mix top-level directories')
    }
  }
  assert.ok(bundled.bundles.some((item) => item.entries.length > 1), 'at least one bundle must hold more than one hunk')
})

test('a single-file change short-circuits instead of being split', () => {
  const { result } = runP0P1('proto-field-removed')
  const bundled = bundle(keyed(result.selected))
  assert.equal(bundled.bundles.length, 1)
  assert.ok(['short-circuit-single', 'short-circuit-small'].includes(bundled.strategy))
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
      assert.equal(verdict.start, null, 'an unanchored verdict must not carry a line number')
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

test('a PARAPHRASE never anchors, even when the intent is obvious', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'api/handler.go', locator: {}, excerpt: 'if len(orders) > 0 {' },
    { path: 'api/handler.go', content: 'if len(orders) == 0 {' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('indentation and diff markers are tolerated; nothing else is', () => {
  const documents = [{ path: 'src/a.ts', content: 'function f() {\n    return 1\n}\n' }]
  const tolerated = anchor.verify({ kind: 'diff-line', path: 'src/a.ts', locator: {}, excerpt: '+\treturn  1' }, { path: 'src/a.ts', documents })
  assert.equal(tolerated.status, 'anchored')
  assert.equal(tolerated.start, 2)

  const punctuation = anchor.verify({ kind: 'diff-line', path: 'src/a.ts', locator: {}, excerpt: 'return 1;' }, { path: 'src/a.ts', documents })
  assert.equal(punctuation.status, 'unanchored', 'a changed semicolon is a changed line')
})

test('a wrong line number is refused rather than repaired', () => {
  const documents = [{ path: 'src/a.ts', content: 'const a = 1\nconst b = 2\n' }]
  const verdict = anchor.verify({ kind: 'diff-line', path: 'src/a.ts', locator: { startLine: 99 }, excerpt: 'const b = 2' }, { path: 'src/a.ts', documents })
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a cross-file relocation must be unique — two candidates means refusal', () => {
  const documents = [
    { path: 'src/one.ts', content: 'const shared = 1\n' },
    { path: 'src/two.ts', content: 'const shared = 1\n' },
  ]
  const ambiguous = anchor.verify({ kind: 'diff-line', path: 'src/missing.ts', locator: {}, excerpt: 'const shared = 1' }, { path: 'src/missing.ts', documents })
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['src/one.ts:1', 'src/two.ts:1'])

  const unique = anchor.verify({ kind: 'diff-line', path: 'src/missing.ts', locator: {}, excerpt: 'const shared = 1' }, { path: 'src/missing.ts', documents: [documents[0]] })
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify({ kind: 'requirement-and-metric', path: 'src/a.ts', locator: {}, excerpt: 'x' }, { path: 'src/a.ts', content: 'x\n' })
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'diff-line' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'diff-line', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'diff-line', path: 'a', locator: { side: 'both' }, excerpt: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['api/handler.go'],
  bundle: { key: 'api', paths: ['api/handler.go'], rules: ['api-compatibility'] },
  ruleText: '<rules path="api/handler.go">\n接口兼容：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [{ id: 'f1', path: 'api/handler.go', evidence: 'if len(orders) == 0 {', message: '一条有证据的发现', defended: true }],
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
  assert.doesNotMatch(P6.system, /本轮负责的路径/u)
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /接口兼容/u)
  assert.match(P4.system, /500/)
  assert.doesNotMatch(P6.system, /接口兼容/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts repeat the anchor law: quote the text, never the line number', () => {
  for (const text of [P4.system, P6.system]) assert.match(text, /行号/u)
  assert.match(P4.system, /不要输出行号/u)
})

test('接口兼容 appears in P4 and not in P6 — the domain is a different question, not a different anchor', () => {
  assert.match(P4.system, /接口兼容/u)
  assert.doesNotMatch(P6.system, /接口兼容/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
})

test('flipping the orientation flips the loss sentence, so the pack cannot be silently re-pointed', () => {
  const recall = prompts.review({ ...reviewContext, orientation: 'recall-first' })
  assert.notEqual(recall.system, P4.system)
  assert.match(recall.system, /recall-first/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const DOCS = [
  { path: 'src/a.ts', content: 'line1\nline2\nneedle here\nline4\n' },
  { path: 'src/b.ts', content: 'needle also here\n' },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('the reused read_lines tool is bounded and says when it cut', async () => {
  const tool = toolByName('read_lines')
  const big = { path: 'src/big.ts', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 'src/big.ts', documents: [big] }, {})
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.ok(result.provenance.length > 0)
})

await testAsync('the reused search tool caps its hits and reports what it scanned', async () => {
  const result = await toolByName('search_diff').execute({ pattern: 'needle', documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => `${item.path}:${item.line}`), ['src/a.ts:3', 'src/b.ts:1'])
  assert.match(result.provenance, /2 个文件/u)
})

await testAsync('a request naming an absent document fails loudly', async () => {
  assert.throws(() => toolByName('read_lines').execute({ path: 'src/nope.ts', documents: DOCS }, {}), /文档集里没有/u)
})


await testAsync('interface_delta finds declaration shapes in the ADDED lines, and says it is a coarse scan', async () => {
  const tool = toolByName('interface_delta')
  const document = {
    path: 'api/store.go',
    content: '@@ -1,3 +1,5 @@\n package api\n+type Order struct {\n+\tID string\n+}\n+func (s *Store) Get(ctx context.Context) error {',
  }
  const result = await tool.execute({ documents: [document] }, {})
  assert.equal(result.items.length, 2, JSON.stringify(result.items))
  assert.deepEqual(result.items.map((item) => item.kind), ['go-type', 'go-func'])
  assert.match(result.provenance, /仅新增行/u)
  assert.match(result.provenance, /非语法解析/u)

  const everything = await tool.execute({ documents: [document], side: 'all' }, {})
  assert.ok(everything.items.length >= result.items.length)
  assert.match(everything.provenance, /全部行/u)
})

await testAsync('interface_delta caps its hits and says when it cut', async () => {
  const tool = toolByName('interface_delta')
  const body = Array.from({ length: 200 }, (_, index) => '+type T' + index + ' struct {').join('\n')
  const result = await tool.execute({ documents: [{ path: 'api/many.go', content: body }] }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('interface_delta names the available documents when the requested path is absent', async () => {
  assert.throws(() => toolByName('interface_delta').execute({ documents: DOCS, path: 'src/none.ts' }, {}), /文档集里没有/u)
})


test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('backend-engineering', 'interface_delta'), 'adjudicate_backend_engineering_evidence_interface_delta')
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
            structured: { findings: [{ id: 'f1', path: 'api/handler.go', evidence: 'if len(orders) == 0 {', message: '一条有证据的发现', defended: true }] },
          }),
          dispose: async () => {},
        }
      },
    },
  }, { maxRounds: 3, maxFindings: 10 })

  const { result } = runP0P1('happy-path')
  const bundled = bundle(keyed(result.selected))
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
  assert.match(requests[0].prompt[0].text, /后端工程/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /不要输出行号/u, 'the anchor law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage and the report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

/** Anchor a candidate with the DOMAIN verifier — never with a self-reported line. */
function anchorFinding(candidate, documents, extra = {}) {
  const added = String(candidate.text).split(/\r?\n/u).filter((line) => line.startsWith('+') && line.slice(1).trim() !== '')
  assert.ok(added.length > 0, `${candidate.path} must contain an added line to anchor`)
  for (const line of added) {
    const excerpt = line.slice(1)
    const verdict = anchor.verify({ kind: 'diff-line', path: candidate.path, locator: { side: 'new' }, excerpt },
      { path: candidate.path, documents })
    if (verdict.status === 'anchored') {
      return { id: candidate.id, path: candidate.path, start: verdict.start, anchorTier: verdict.tier, severity: 'high', evidence: excerpt, defended: true, ...extra }
    }
  }
  throw new Error(`${candidate.path}: none of its added lines could be anchored by the domain verifier`)
}

/** The added lines of a diff, keyed by file, as the verifier's document set. */
function addedLinesByFile(payload) {
  const documents = new Map()
  let path = null
  for (const line of String(payload.diff).split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/u.exec(line)
    if (header !== null) { path = header[1]; if (!documents.has(path)) documents.set(path, []); continue }
    if (path === null) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) documents.get(path).push(line.slice(1))
    else if (!line.startsWith('-') && !line.startsWith('@@') && !line.startsWith('diff ') && !line.startsWith('index ') && !line.startsWith('\\')) documents.get(path).push(line)
  }
  return [...documents].map(([docPath, lines]) => ({ path: docPath, content: lines.join('\n') }))
}

test('coverage is computed from engine verdicts, and the numbers follow the input', () => {
  const payload = fixture('happy-path').input.payload
  const documents = addedLinesByFile(payload)
  const { result } = runP0P1('happy-path')
  const two = result.selected.slice(0, 2).map((candidate) => anchorFinding(candidate, documents))
  const proof = coverage(result.selected.length, two)
  assert.equal(proof.total, result.selected.length)
  assert.equal(proof.reviewed, 2)
  assert.equal(proof.coverageRate, Number((2 / result.selected.length).toFixed(4)))
  assert.equal(proof.complete, false)

  const all = result.selected.map((candidate) => anchorFinding(candidate, documents))
  assert.equal(coverage(result.selected.length, all).coverageRate, 1)
  assert.equal(coverage(result.selected.length, all).complete, true)
})

test('precision-first drops what it cannot prove and keeps what it can', () => {
  const payload = fixture('happy-path').input.payload
  const documents = addedLinesByFile(payload)
  const { result } = runP0P1('happy-path')
  const proven = anchorFinding(result.selected[0], documents)
  const bare = { id: 'bare', path: result.selected[0].path, severity: 'high', evidence: '感觉不太对', defended: false }
  const panel = runCritiquePanel([proven, bare], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), [proven.id])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['bare'])
  assert.equal(panel.kind, 'fact-checker')
})

test('an UNANCHORED finding is excluded from the effective findings AND from coverage', () => {
  const payload = fixture('happy-path').input.payload
  const documents = addedLinesByFile(payload)
  const { result } = runP0P1('happy-path')
  const anchored = anchorFinding(result.selected[0], documents)
  const unanchored = { id: 'ghost', path: 'src/missing.ts', severity: 'high', evidence: '没有锚点的断言' }
  const effective = [anchored, unanchored].filter((finding) => Number.isInteger(finding.start) && finding.start > 0)
  assert.equal(effective.length, 1)
  assert.equal(coverage(result.selected.length, effective).reviewed, 1)
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const payload = fixture('happy-path').input.payload
  const documents = addedLinesByFile(payload)
  const { result } = runP0P1('happy-path')
  const proven = anchorFinding(result.selected[0], documents)
  const panel = runCritiquePanel([proven], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture happy-path',
    scope: { admitted: result.selected.length, excluded: 0, bundles: 2 },
    findings: panel.kept,
    coverageProof: coverage(result.selected.length, panel.kept),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'backend-engineering')
  assert.equal(built.lossOrientation, 'precision-first')
  assert.equal(built.criticismKind, 'fact-checker')
  assert.equal(built.coverage.reviewed, 1)
  assert.equal(built.generatedAt, null, 'a deterministic engine must not stamp wall-clock time')
})

// ---------------------------------------------------------------------------
// The domain as loaded from disk
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: 'backend-engineering', dir: 'domains/backend-engineering' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'diff-hunks')
  assert.equal(assembled.anchorVerifier.kind, 'diff-line')
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

await testAsync('adjudication_plan consumes the fixture diff through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'backend-engineering',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'diff-hunks')
  assert.equal(plan.candidateSet.inputFormat, 'unified-diff')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the object form must be applied, not merely declared')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['api', 'db', 'worker'])
  assert.ok(plan.bundles.some((item) => item.paths.length > 1), 'two hunks of one directory must share a bundle')
  assert.equal(plan.criticism.kind, 'fact-checker')
  assert.match(plan.summary, /复核者：fact-checker/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'backend-engineering',
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
    domain: 'backend-engineering',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  // Through the plugin the pack's OWN gate applies — and since t8 the pack
  // declares `**/generated/**` itself, so EVERY candidate is excluded here.
  // (Before that, the fixture's extra exclude rule was the only thing removing
  // generated code and one candidate survived through the plugin.)
  assert.deepEqual(predicates, {
    'assets/logo.png': 'binary',
    'config/.env': 'secret',
    'legacy/old.go': 'deleted',
    'node_modules/leftpad/index.js': 'default-path',
    'README.md': 'extension',
    'generated/types.ts': 'user-exclude',
  })
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /排除 6 项/u)
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'backend-engineering' }, {})
  const listed = await ctx.__tools.get('adjudicate_backend_engineering_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand, and deactivation removes them', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'backend-engineering' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName('backend-engineering', tool.name)), `${tool.name} must be registered on activation`)
  }
  const own = ctx.__tools.get(evidenceToolName('backend-engineering', 'interface_delta'))
  assert.equal(typeof own.execute, 'function')

  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'backend-engineering' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('backend-engineering', tool.name)), false)
  }
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'backend-engineering',
    target: 'replacement probe',
    candidates: [
      { path: 'api/a.ts', additions: 1 },
      { path: 'api/b.ts', additions: 1 },
      { path: 'other/c.ts', additions: 1 },
      { path: 'other/d.ts', additions: 1 },
    ],
  }, {})
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['api', 'other'].sort())
  assert.ok(plan.bundles.every((item) => item.paths.length === 2), 'two files of one directory in ONE bundle each')

  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19, 'replacement must not change the domain count')
  assert.ok(listed.directory.replaced.includes('backend-engineering'))
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
