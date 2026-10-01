/**
 * ux-review — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  one candidate per (branch, step)
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey                  ->  real grouping BY BRANCH, not by path
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  step-side binding + verbatim evidence
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * Then it drives the assembled pack through the plugin's own mock Cordis
 * context, so the domain is proven to work where it is actually used.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 * ------------------------------------
 * 1. It never asserts a status without asserting the TIER. "anchored" alone is
 *    satisfiable by a verifier that guesses; the tier is what says it did not.
 * 2. It never lets P4 and P6 share a prompt. `assert.notEqual(p6.system,
 *    p4.system)` is load-bearing: the validators do NOT check it.
 * 3. It never asserts coverage from a SELF-REPORTED anchor. Every anchor used in
 *    the end-to-end part comes out of this domain's own `anchor.verify()` first,
 *    and the numbers are derived from those verdicts.
 *
 * Usage: `node domains/ux-review/test.mjs`
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
  validateCandidateSetResult,
  validateDomainPackV2,
  validateEvidenceToolkit,
  validateRuleDocument,
  validateAnchorVerdict,
  validatePromptOutput,
} from '../../lib/contracts.js'
import {
  DEFAULT_GATE_PREDICATES,
  DEFAULT_EXCLUDE_PATTERNS,
  bundle,
  coverage,
  createBudget,
  gate,
  report,
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { loadDomain, loadDomains, createNodeIo } from '../../lib/domain-loader.js'
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

const countByBranch = (candidates) => {
  const counts = {}
  for (const candidate of candidates) {
    const id = candidate.meta?.branchId ?? '(none)'
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\nux-review domain — contract v2 end-to-end')
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
    ruleLibrary: { dir: 'rules', rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['**'], text: 'y'.repeat(12), needsExpertReview: true })) },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('ux-review')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(declared.format, 'flow-spec')
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(declared.bounded, true)
  assert.equal(source.bounded, true)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.kind, 'flow-step-and-node')
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable')
})

test('this domain is precision-first and its reviewer shape agrees', () => {
  assert.equal(pack.lossOrientation, 'precision-first')
  assert.equal(pack.criticism.kind, 'fact-checker')
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.ok(evidence.tools.length > 0)
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxLines > 0 && tool.limits.maxItems > 0 && tool.limits.maxCalls > 0, `${tool.name} must declare positive limits`)
    assert.ok(tool.limits.maxLines <= 2000 && tool.limits.maxItems <= 1000, `${tool.name} must stay under the hard ceilings`)
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

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'screen-only', match: ['**/screens/**'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**'], text: 'y'.repeat(20) },
  ], ['checkout/happy/s2'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('rule selection over the real library injects the matching rules, and only those', () => {
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = /^name:\s*(.+)$/mu.exec(text)?.[1]?.trim()
    const match = [...text.matchAll(/^\s+- "(.+)"$/gmu)].map((hit) => hit[1])
    return { name, match, text: 'body' }
  })
  const { injected } = selectRules(rules, ['checkout/happy/s2'])
  const names = injected.map((rule) => rule.name)
  assert.ok(names.includes('recoverability'))
  assert.ok(names.includes('state-completeness'))
  assert.equal(new Set(names).size, names.length, 'no rule may be injected twice')
  assert.equal(names.length, rules.length, 'every rule in this library matches every flow path ("**")')
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  assert.ok(FIXTURES.has('undeclared-branch'), 'this domain must ship the class the contract table names')
})

test('every fixture declares anchors with both positive and negative cases', () => {
  for (const [name, value] of FIXTURES) {
    assert.ok(value.anchors, `${name} must declare anchors`)
    assert.ok(value.anchors.positive?.length > 0, `${name} needs a positive anchor case`)
    assert.ok(value.anchors.negative?.length > 0, `${name} needs a negative anchor case`)
  }
  const allNegatives = [...FIXTURES.values()].flatMap((value) => value.anchors.negative ?? [])
  assert.ok(allNegatives.some((entry) => entry.expectTier === 'no-match'), 'at least one negative must be a refused claim')
  assert.ok(allNegatives.some((entry) => entry.expectTier === 'relocation-ambiguous'), 'at least one negative must be a refused cross-file ambiguity')
})

// ---------------------------------------------------------------------------
// P0 / P1 — the three boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — empty / all-gated-out / admitted')

test('boundary: an empty flow produces an EMPTY candidate set', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  assert.equal(enumerated.candidates.length, fixture('empty').expect.candidates)
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
})

test('boundary: all-gated-out enumerates candidates and the gate removes EVERY one', () => {
  const expected = fixture('all-gated-out').expect
  const { enumerated, result } = runP0P1('all-gated-out')

  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path).sort(), [...expected.paths].sort())
  assert.equal(result.selected.length, expected.admitted, 'the gate must admit nothing here')
  assert.equal(result.excluded.length, expected.candidates)

  const predicates = byPredicate(result)
  for (const [predicate, paths] of Object.entries(expected.excludedByPredicate)) {
    assert.deepEqual(predicates[predicate] ?? [], [...paths].sort(), `predicate "${predicate}" mismatch`)
  }
})

test('boundary: an empty set and a fully-excluded set are distinguishable in the plan', () => {
  const empty = runP0P1('empty')
  const gatedOut = runP0P1('all-gated-out')
  assert.equal(empty.enumerated.candidates.length, 0)
  assert.equal(empty.result.excluded.length, 0)
  assert.ok(gatedOut.enumerated.candidates.length > 0, 'all-gated-out: P0 produced something')
  assert.ok(gatedOut.result.excluded.length > 0, 'all-gated-out: P1 removed it')
})

test('happy path: every (branch, step) candidate is admitted, and the per-branch split is real', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
  assert.deepEqual(countByBranch(enumerated.candidates), expected.branchCounts)
})

test('a branch naming a step the flow does not contain is REPORTED, not silently dropped', () => {
  const expected = fixture('undeclared-branch').expect
  const { enumerated, result } = runP0P1('undeclared-branch')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path).sort(), [...expected.paths].sort())
  assert.equal(result.selected.length, expected.admitted)
  const dangling = enumerated.excluded.find((entry) => entry.id === `happy:${expected.danglingStep}`)
  assert.ok(dangling !== undefined, 'the dangling step reference must appear in excluded')
  assert.match(dangling.reason, /不存在/u)
})

test('the gate is the engine\'s ordered predicate list, and the pack only narrows it', () => {
  assert.deepEqual(gate([], {}).ordered, DEFAULT_GATE_PREDICATES.map(([label]) => label))
  assert.deepEqual(pack.gate.exclude, ['**/.git/**', '**/dist/**', '**/build/**', '**/exported/**'])
  for (const pattern of pack.gate.exclude) {
    assert.ok(DEFAULT_EXCLUDE_PATTERNS.includes(pattern) || ['**/build/**', '**/exported/**'].includes(pattern),
      `"${pattern}" is not one of the engine's default patterns — justify it or drop it`)
  }
  assert.ok(!pack.gate.exclude.includes('**/node_modules/**'), 'node_modules is covered by default-path')
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ branches: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ flow: { steps: 'nope' } }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ flow: {}, branches: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ flow: { id: 'f', steps: [] }, branches: [] }, {}))
})

test('candidate ids are unique, paths are gate-globable, and the branch scope leads the path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.match(candidate.path, /^[a-z0-9][a-z0-9._:/-]*$/u, `${candidate.id} path must be globbable`)
    assert.equal(candidate.path.split('/')[0], 'checkout', `${candidate.id} must carry the flow scope first`)
    assert.equal(candidate.path.split('/').slice(0, 2).join('/'), candidate.meta.branchKey)
    assert.equal(typeof candidate.locator.stepId, 'string', `${candidate.id} needs the step half`)
    assert.equal(typeof candidate.locator.branchId, 'string', `${candidate.id} needs the branch half`)
  }
})

test('the source reports malformed branches and empty step tables rather than dropping them', () => {
  const enumerated = source.enumerate({
    flow: { id: 'f', steps: [{ id: 'a', name: 'A', type: 'screen' }] },
    branches: [{ id: 'b', kind: 'happy', steps: [] }, { kind: 'error', steps: ['a'] }, 'nope'],
  }, {})
  assert.equal(enumerated.candidates.length, 0)
  const reasons = enumerated.excluded.map((entry) => entry.reason)
  assert.ok(reasons.some((reason) => /步骤表为空/u.test(reason)), JSON.stringify(reasons))
  assert.ok(reasons.some((reason) => /缺少 id/u.test(reason)), JSON.stringify(reasons))
  assert.ok(reasons.some((reason) => /不是对象/u.test(reason)), JSON.stringify(reasons))
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling by branch (not by path)')

test('bundleKey resolves through the contract helper and is APPLIED', () => {
  const { result } = runP0P1('happy-path')
  for (const entry of result.selected) {
    const resolution = resolveBundleKey(pack, entry, {})
    assert.equal(resolution.applied, true, resolution.reason)
    assert.equal(resolution.source, 'derived')
    assert.equal(resolution.strategy, 'flow-branch')
  }
})

test('the multi-branch flow really splits into one bundle PER BRANCH', () => {
  const expected = fixture('happy-path').expect
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: resolveBundleKey(pack, entry, {}).key }))
  const bundled = bundle(keyed)
  assert.deepEqual(bundled.bundles.map((item) => item.key).sort(), expected.bundleKeys)
  assert.equal(bundled.bundles.length, 3)
  assert.notEqual(bundled.strategy, 'short-circuit-single')
})

test('two steps of the SAME branch land in one bundle (not just applied:true)', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: resolveBundleKey(pack, entry, {}).key }))
  const bundled = bundle(keyed)

  const happy = bundled.bundles.find((item) => item.key === 'checkout/happy')
  assert.ok(happy !== undefined, 'the happy branch must form its own bundle')
  assert.equal(happy.entries.length, 4)
  assert.equal(new Set(happy.entries.map((entry) => entry.meta.stepId)).size, 4)
  assert.equal(new Set(happy.entries.map((entry) => entry.meta.branchId)).size, 1)

  for (const item of bundled.bundles) {
    assert.equal(new Set(item.entries.map((entry) => entry.meta.branchId)).size, 1,
      `bundle "${item.key}" mixed branches: ${item.entries.map((entry) => entry.meta.branchId).join(' | ')}`)
  }
})

test('the same step on two different branches is TWO candidates in TWO different bundles', () => {
  const { enumerated } = runP0P1('undeclared-branch')
  const w1 = enumerated.candidates.filter((candidate) => candidate.meta.stepId === 'w1')
  assert.equal(w1.length, 2, 'w1 is reached by two branches, so it is two candidates')
  const keys = w1.map((candidate) => resolveBundleKey(pack, candidate, {}).key).sort()
  assert.deepEqual(keys, ['onboarding/happy', 'onboarding/returning'])
})

// ---------------------------------------------------------------------------
// P5 — the anchor verifier, positive and negative
// ---------------------------------------------------------------------------

console.log('\nP5 — anchors (step-side binding + evidence side)')

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
      if (entry.expectStep !== undefined) assert.equal(verdict.step, entry.expectStep,
        'an anchored verdict must name the step-side binding it recomputed')
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
      assert.equal(verdict.step, null)
      assert.equal(typeof verdict.detail, 'string', 'every unanchored verdict must explain itself')
    })
  }
  for (const entry of value.anchors.ambiguous ?? []) {
    test(`anchor ambiguous [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, 'unanchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.ok(Array.isArray(verdict.ambiguousIn) && verdict.ambiguousIn.length > 1,
        'an ambiguous verdict must list the competing locations')
      if (entry.expectAmbiguousIn !== undefined) assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
    })
  }
}

// --- the step-side binding, half by half -----------------------------------

const FLOW = { id: 'f', steps: [{ id: 'a', name: 'A', type: 'screen', next: 'b' }, { id: 'b', name: 'B', type: 'screen' }] }
const BRANCHES = [
  { id: 'happy', kind: 'happy', steps: ['a', 'b'] },
  { id: 'error', kind: 'error', steps: ['b'] },
]
const DOC = [{ path: 'f/happy/a', content: '步骤 a — A（类型 screen）\n  next = b\n' }]
const SUBJECT = { path: 'f/happy/a', flow: FLOW, branches: BRANCHES, documents: DOC }

test('STEP SIDE: a step that exists in the flow but NOT on the claimed branch is refused', () => {
  const verdict = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/error/a', locator: { branchId: 'error', stepId: 'a' }, excerpt: 'next = b' },
    { path: 'f/error/a', flow: FLOW, branches: BRANCHES, documents: DOC },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /不在这个分支上/u)
})

test('STEP SIDE: a branch the flow does not have is refused', () => {
  const verdict = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/ghost/a', locator: { branchId: 'ghost', stepId: 'a' }, excerpt: 'next = b' },
    { path: 'f/ghost/a', flow: FLOW, branches: BRANCHES, documents: DOC },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('STEP SIDE: an incomplete binding (branch or step missing) is refused, not half-credited', () => {
  for (const locator of [{ branchId: 'happy' }, { stepId: 'a' }]) {
    const verdict = anchor.verify(
      { kind: 'flow-step-and-node', path: 'f/happy/a', locator, excerpt: 'next = b' },
      SUBJECT,
    )
    assert.equal(verdict.status, 'unanchored', JSON.stringify(locator))
    assert.equal(verdict.tier, 'no-match')
  }
})

test('neither a flow nor a branch list means the step side cannot be recomputed at all', () => {
  const verdict = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/happy/a', locator: { branchId: 'happy', stepId: 'a' }, excerpt: 'next = b' },
    { path: 'f/happy/a', documents: DOC },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-documents')
})

test('BOTH halves hold -> anchored, and the verdict names the binding it recomputed', () => {
  const verdict = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/happy/a', locator: { branchId: 'happy', stepId: 'a' }, excerpt: 'next = b' },
    SUBJECT,
  )
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'recomputed-unique')
  assert.equal(verdict.step, 'happy/a')
  assert.equal(verdict.start, 2)
})

test('a paraphrase never anchors, even when the intent is obvious', () => {
  const verdict = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/happy/a', locator: { branchId: 'happy', stepId: 'a' }, excerpt: '下一步 = b' },
    SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/happy/a', locator: { branchId: 'happy', stepId: 'a', startLine: 99 }, excerpt: 'next = b' },
    SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('indentation is tolerated; punctuation is not', () => {
  const tolerated = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/happy/a', locator: { branchId: 'happy', stepId: 'a' }, excerpt: '  next=b' },
    SUBJECT,
  )
  assert.equal(tolerated.status, 'anchored')

  const punctuation = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/happy/a', locator: { branchId: 'happy', stepId: 'a' }, excerpt: 'next == b' },
    SUBJECT,
  )
  assert.equal(punctuation.status, 'unanchored', 'a changed operator is a changed line')
})

test('a cross-file relocation must be unique, and the competing locations are listed', () => {
  const documents = [
    { path: 'f/one/x', content: 'next = b\n' },
    { path: 'f/two/x', content: 'next = b\n' },
  ]
  const ambiguous = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/missing/x', locator: { branchId: 'happy', stepId: 'a' }, excerpt: 'next = b' },
    { path: 'f/missing/x', flow: FLOW, branches: BRANCHES, documents },
  )
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['f/one/x:1', 'f/two/x:1'])

  const unique = anchor.verify(
    { kind: 'flow-step-and-node', path: 'f/missing/x', locator: { branchId: 'happy', stepId: 'a' }, excerpt: 'next = b' },
    { path: 'f/missing/x', flow: FLOW, branches: BRANCHES, documents: [documents[0]] },
  )
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
  assert.equal(unique.path, 'f/one/x')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'layer-and-token', path: 'f/happy/a', locator: { branchId: 'happy', stepId: 'a' }, excerpt: 'next = b' },
    SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'flow-step-and-node' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'flow-step-and-node', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['checkout/happy/s2'],
  bundle: { key: 'checkout/happy', paths: ['checkout/happy/s2'], rules: ['recoverability'] },
  ruleText: '<rules path="checkout/happy/s2">\n可恢复性：破坏性动作没有撤销。\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', branchId: 'happy', stepId: 's2', path: 'checkout/happy/s2', evidence: 'onError = s2', message: '错误后回到同一页，用户无法脱困', defended: true },
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
  assert.doesNotMatch(P6.system, /本轮负责的分支/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /可恢复性/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /可恢复性：破坏性动作没有撤销/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts repeat the two-sided anchor law', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /锚点/u)
  }
  assert.match(P4.system, /不要输出行号/u)
  assert.match(P4.system, /分支 id/u)
  assert.match(P4.system, /步骤 id/u)
  assert.match(P6.system, /步骤侧/u)
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

test('the prompts tell the model the rule library is NOT expert-validated', () => {
  assert.match(P4.system, /needs-expert-review/u)
  assert.match(P4.system, /未经领域专家审定/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const EV_FLOW = {
  id: 'f',
  steps: [
    { id: 'a', name: 'A', type: 'screen', next: 'b' },
    { id: 'b', name: 'B', type: 'form', next: 'c', onError: 'b' },
  ],
}
const EV_BRANCHES = [{ id: 'happy', kind: 'happy', steps: ['a', 'b'] }]
const EV_NODES = [{ id: 'a', name: 'A 屏', screen: 'screens/a.png' }]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('list_branch_steps cross-checks the branch against the flow and flags dangling step ids', async () => {
  const tool = toolByName('list_branch_steps')
  const result = await tool.execute({
    branchId: 'happy',
    flow: EV_FLOW,
    branches: [{ id: 'happy', kind: 'happy', steps: ['a', 'b', 'ghost'] }],
  }, {})
  assert.equal(result.items.length, 3)
  assert.deepEqual(result.items.map((item) => item.existsInFlow), [true, true, false])
  assert.match(result.provenance, /1 个在流程步骤表里不存在/u)
  assert.equal(result.truncated, false)
})

await testAsync('list_branch_steps caps its item count and reports the cap', async () => {
  const tool = toolByName('list_branch_steps')
  const steps = Array.from({ length: 200 }, (_, index) => `s${index}`)
  const result = await tool.execute({
    branchId: 'big',
    flow: { id: 'f', steps: steps.map((id) => ({ id })) },
    branches: [{ id: 'big', kind: 'happy', steps }],
  }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('read_step reports how many of the three transitions are declared', async () => {
  const tool = toolByName('read_step')
  const result = await tool.execute({ stepId: 'b', flow: EV_FLOW }, {})
  assert.equal(result.items[0].declaredTransitions, 2)
  assert.equal(result.items[0].next, 'c')
  assert.equal(result.truncated, false)
})

await testAsync('find_node refuses to invent a node and says the empty result is itself a candidate', async () => {
  const tool = toolByName('find_node')
  const missing = await tool.execute({ stepId: 'b', prototype: { nodes: EV_NODES } }, {})
  assert.deepEqual(missing.items, [])
  assert.match(missing.notes[0], /本身是一个候选/u)

  const found = await tool.execute({ stepId: 'a', prototype: { nodes: EV_NODES } }, {})
  assert.equal(found.items.length, 1)
  assert.equal(found.items[0].screen, 'screens/a.png')
})

await testAsync('a request naming an absent branch fails loudly with the available branches', async () => {
  const tool = toolByName('list_branch_steps')
  assert.throws(() => tool.execute({ branchId: 'nope', flow: EV_FLOW, branches: EV_BRANCHES }, {}),
    /分支表里没有 "nope"/u)
})

await testAsync('a request with no flow context is refused, not answered with "nothing found"', async () => {
  const tool = toolByName('read_step')
  assert.throws(() => tool.execute({ stepId: 'a' }, {}), /缺少 `flow.steps`/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('ux-review', 'list_branch_steps'), 'adjudicate_ux_review_evidence_list_branch_steps')
})

// ---------------------------------------------------------------------------
// P4 — the review prompt through the reasoner
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
                branchId: 'happy',
                stepId: 's2',
                path: 'checkout/happy/s2',
                evidence: 'onError = s2',
                message: '错误后回到同一页',
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
  const bundled = bundle(result.selected.map((entry) => ({ ...entry, key: resolveBundleKey(pack, entry, {}).key })))
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
  assert.equal(outcome.findings.length, bundled.bundles.length)
  assert.match(requests[0].prompt[0].text, /UX 交互设计/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /不要输出行号/u, 'the anchor law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('precision-first drops what it cannot prove and keeps what it can', () => {
  const panel = runCritiquePanel([
    { id: 'proven', path: 'checkout/happy/s2', start: 3, severity: 'high', evidence: 'onError = s2', defended: true },
    { id: 'bare', path: 'checkout/happy/s3', start: 6, severity: 'low', evidence: '' },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['proven'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['bare'])
  assert.equal(panel.kind, 'fact-checker')
})

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(5, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 5)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, 0.4)
  assert.equal(proof.complete, false)
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  const findings = [
    { id: 'a1', path: 'checkout/happy/s2', start: 3, severity: 'high', evidence: 'x', defended: true },
    { id: 'a2', path: 'checkout/error/s4', severity: 'high', evidence: 'y', defended: true },
  ]
  const anchored = findings.filter((finding) => typeof finding.start === 'number' && finding.start > 0)
  assert.equal(anchored.length, 1)
  const proof = coverage(8, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, Number((1 / 8).toFixed(4)), 'the unanchored path must not be counted as reviewed')
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([
    { id: 'f', path: 'checkout/happy/s2', start: 3, severity: 'high', evidence: 'x', defended: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 8, excluded: 0, bundles: 3 },
    findings: panel.kept,
    coverageProof: coverage(8, panel.kept),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'ux-review')
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

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: 'ux-review', dir: 'domains/ux-review' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'flow-steps')
  assert.equal(assembled.anchorVerifier.kind, 'flow-step-and-node')
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
  const mine = result.packs.find((item) => item.id === 'ux-review')
  assert.ok(mine !== undefined, `ux-review must load; problems: ${JSON.stringify(result.problems)}`)
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
    domain: 'ux-review',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'flow-steps')
  assert.equal(plan.candidateSet.inputFormat, 'flow-spec')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.strategy, 'flow-branch')
  assert.equal(plan.bundleKey.derived, plan.gate.admitted)
  assert.equal(plan.bundles.length, 3, 'a three-branch flow must form three bundles')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), happy.expect.bundleKeys)
  const happyBundle = plan.bundles.find((item) => item.key === 'checkout/happy')
  assert.ok(happyBundle !== undefined, 'the happy branch must form its own bundle')
  assert.equal(happyBundle.paths.length, 4, 'all four steps of the happy branch must be judged together')
  assert.equal(new Set(happyBundle.paths).size, 4)
  assert.equal(plan.criticism.kind, 'fact-checker')
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ux-review',
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
    domain: 'ux-review',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})

  assert.equal(plan.gate.admitted, 0)
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'checkout/archived/s2': 'deleted',
    'checkout/bulk/s4': 'too-large',
    'checkout/exported/s1': 'user-exclude',
    'checkout/imageonly/s3': 'binary',
  })
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /排除 4 项/u)
})

await testAsync('P0 -> P7 round trip: anchors come from the DOMAIN verifier, and the rate follows them', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const payload = happy.input.payload

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ux-review',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload },
  }, {})

  const enumerated = source.enumerate(payload, { maxCandidates: 400, maxExcerptLines: 500 })
  const documents = enumerated.candidates.map((candidate) => ({ path: candidate.path, content: candidate.text }))

  const anchoredFindings = []
  for (const candidate of enumerated.candidates.slice(0, 3)) {
    const lines = String(candidate.text).split('\n').filter((line) => line.trim() !== '')
    const excerpt = lines[lines.length - 1]
    const verdict = anchor.verify({
      kind: 'flow-step-and-node',
      path: candidate.path,
      locator: { branchId: candidate.meta.branchId, stepId: candidate.meta.stepId },
      excerpt,
    }, { path: candidate.path, flow: payload.flow, branches: payload.branches, documents })
    assert.equal(verdict.status, 'anchored', `${candidate.id} must anchor through the domain verifier: ${verdict.detail}`)
    assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier))
    anchoredFindings.push({
      id: candidate.id,
      path: verdict.path,
      // CHANGED (t22): `branchId`/`stepId` used to sit at the TOP LEVEL of the
      // finding and never reached the domain verifier — `recomputeAnchor`
      // (index.js:755-762) passes `finding.locator` through VERBATIM and only
      // folds the top-level `start`/`end` convenience fields in when there is no
      // locator at all. The step-side key belongs in `locator`.
      locator: { branchId: candidate.meta.branchId, stepId: candidate.meta.stepId },
      severity: 'high',
      message: `step ${candidate.meta.stepId} on branch ${candidate.meta.branchId}`,
      excerpt,
      evidence: excerpt,
      defended: true,
    })
  }
  assert.equal(anchoredFindings.length, 3)

  const paraphrase = anchor.verify({
    kind: 'flow-step-and-node',
    path: enumerated.candidates[0].path,
    locator: { branchId: enumerated.candidates[0].meta.branchId, stepId: enumerated.candidates[0].meta.stepId },
    excerpt: '大概是说这一步会跳到下一步',
  }, { path: enumerated.candidates[0].path, flow: payload.flow, branches: payload.branches, documents })
  assert.equal(paraphrase.status, 'unanchored')

  const paraphraseFinding = {
    id: 'f-paraphrase',
    path: enumerated.candidates[0].path,
    locator: { branchId: enumerated.candidates[0].meta.branchId, stepId: enumerated.candidates[0].meta.stepId },
    severity: 'high',
    message: '转述而非抄写',
    excerpt: '大概是说这一步会跳到下一步',
    evidence: '大概是说这一步会跳到下一步',
  }

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'ux-review',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    // CHANGED (t22): `documents` is REQUIRED for the engine to recompute the
    // evidence side (index.js:768). The old submission never passed it.
    documents,
    findings: [...anchoredFindings, paraphraseFinding],
  }, {})

  assert.equal(submitted.coverage.total, plan.gate.admitted, 'total is the gate\'s admitted count, not a number picked to look complete')
  assert.equal(submitted.coverage.coverageRate, Number((submitted.coverage.reviewed / plan.gate.admitted).toFixed(4)))

  // ---------------------------------------------------------------------
  // CHANGED (t22) — MEASURED, NOT BOUNDED.  CHANGED AGAIN (t27).
  //
  // t22 replaced `assert.ok(reviewed <= 3)` (true for 0) with a pinned 0 plus
  // the diagnosis: the engine's P5 subject was `{path, content, document,
  // documents}`, it could not carry this domain's flow/branches, and every
  // finding was refused as `no-documents`.
  //
  // t27 fixed the CAUSE rather than the number. `subject.candidates` — which the
  // contract (§1.2) declared all along and the engine now supplies
  // (index.js:789-803) — is the P0 candidate set, and it IS this domain's
  // locator space. `anchor.js` rebuilds the branch -> steps structure from it,
  // so the same findings now anchor through the real plugin path. The old pinned
  // 0 was a deliberate tripwire: it went red the moment this landed, and the
  // number below is what replaced it.
  // ---------------------------------------------------------------------
  assert.equal(submitted.coverage.reviewed, 3,
    'exactly the three really-anchored findings count — a real number, not an upper bound')
  assert.equal(submitted.coverage.coverageRate, Number((3 / plan.gate.admitted).toFixed(4)))
  assert.equal(submitted.unanchored, 1, 'exactly the paraphrase is unanchored — not "at least one"')
  assert.equal(submitted.anchorVia, 'anchorVerifier',
    'the DOMAIN verifier is the path that ran, and it anchored — the structure was rebuilt from the candidate set')
  assert.deepEqual(
    submitted.unanchoredDetails.map((item) => ({ id: item.id, tier: item.tier })),
    [{ id: 'f-paraphrase', tier: 'no-match' }],
    'the ONLY rejection is the paraphrase, and it is refused as no-match — a real verdict, not "nothing to check against"',
  )
  assert.equal(submitted.findings.length, 3, 'the three anchored findings survive the fact-checker panel')

  // The structure really came from the candidate set, and the rebuilt tables are
  // not a rubber stamp: see the two dedicated tests below. Every KEPT finding
  // must carry a trusted tier the engine recomputed itself.
  assert.ok(submitted.findings.every((finding) => TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier)),
    `every kept finding must carry a trusted tier (got ${submitted.findings.map((f) => f.anchorTier).join(', ')})`)
  assert.ok(!submitted.findings.some((finding) => finding.id === 'f-paraphrase'), 'an unanchored finding is not an effective finding')
  assert.equal(submitted.criticismKind, 'fact-checker')
})

await testAsync('P5 through the real adjudication_anchor: the structure is rebuilt from the P0 candidate set', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const payload = happy.input.payload

  // A real plan first: it is what registers the admitted candidate set the
  // engine hands the verifier (index.js:954, 1286-1289).
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ux-review',
    target: 'anchor probe',
    input: { format: happy.input.format, payload },
  }, {})
  assert.ok(plan.gate.admitted >= 4)

  const enumerated = source.enumerate(payload, { maxCandidates: 400, maxExcerptLines: 500 })
  const documents = enumerated.candidates.map((candidate) => ({ path: candidate.path, content: candidate.text }))
  const excerptOf = (candidate) => {
    const lines = String(candidate.text).split('\n').filter((line) => line.trim() !== '')
    return lines[lines.length - 1]
  }
  const claimFor = (candidate, excerpt = excerptOf(candidate)) => ({
    domain: 'ux-review',
    path: candidate.path,
    // ONLY the domain locator. There is no way to pass `flow`/`branches` through
    // the plugin, so if the verifier cannot rebuild them this can never anchor.
    locator: { branchId: candidate.meta.branchId, stepId: candidate.meta.stepId },
    excerpt,
    documents,
  })

  const target = enumerated.candidates.find((candidate) => candidate.meta.stepId === 's2' && candidate.meta.branchId === 'happy')
  assert.ok(target !== undefined, 'the fixture must contain happy/s2')

  const anchored = await ctx.__tools.get('adjudication_anchor').execute(claimFor(target), {})
  assert.equal(anchored.via, 'anchorVerifier', 'the domain verifier is the path that ran')
  assert.equal(anchored.status, 'anchored', anchored.detail)
  assert.ok(TRUSTED_ANCHOR_TIERS.includes(anchored.tier), `tier "${anchored.tier}" must be trusted`)
  assert.equal(anchored.path, target.path)
  assert.match(anchored.detail, /P0 候选集重建/u, 'the verdict must say where the step-side structure came from')
  assert.equal(anchored.step, `${target.meta.branchId}/${target.meta.stepId}`)

  // --- REBUILD IS A CHECK, NOT A RUBBER STAMP -----------------------------

  // A step that exists nowhere in the candidate set.
  const unknownStep = await ctx.__tools.get('adjudication_anchor').execute({
    ...claimFor(target),
    locator: { branchId: 'happy', stepId: 'not-a-step' },
  }, {})
  assert.equal(unknownStep.status, 'unanchored')
  assert.equal(unknownStep.tier, 'no-match', 'a step outside the candidate locator space must be refused')

  // A step that IS in the candidate set, but not on the claimed branch: the
  // membership map really is recomputed, not just the step registry.
  const wrongBranch = await ctx.__tools.get('adjudication_anchor').execute({
    ...claimFor(target),
    locator: { branchId: 'happy', stepId: 's5' },
  }, {})
  assert.equal(wrongBranch.status, 'unanchored')
  assert.equal(wrongBranch.tier, 'no-match', 's5 is on the empty branch, not on happy — the pair must not bind')

  // --- NO BYPASS: nothing to rebuild => still no-documents -----------------

  // An EMPTY candidate set is a candidate set that establishes nothing. It must
  // not degrade into "fine, then".
  const emptySet = await ctx.__tools.get('adjudication_anchor').execute({ ...claimFor(target), candidates: [] }, {})
  assert.equal(emptySet.status, 'unanchored')
  assert.equal(emptySet.tier, 'no-documents', 'an empty candidate set rebuilds nothing and must still refuse')

  // A candidate set whose entries carry no (step, branch) locator at all.
  const uselessSet = await ctx.__tools.get('adjudication_anchor').execute({
    ...claimFor(target),
    candidates: [{ id: 'x', path: 'whatever', locator: {}, text: '' }],
  }, {})
  assert.equal(uselessSet.status, 'unanchored')
  assert.equal(uselessSet.tier, 'no-documents', 'candidates without a step/branch locator establish no structure')
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'ux-review' }, {})
  const listed = await ctx.__tools.get('adjudicate_ux_review_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'ux-review' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName('ux-review', tool.name)), `${tool.name} must be registered on activation`)
  }
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'ux-review' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('ux-review', tool.name)), false)
  }
})

await testAsync('the registered evidence tool is bounded end to end through the plugin', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'ux-review' }, {})
  const tool = ctx.__tools.get(evidenceToolName('ux-review', 'list_branch_steps'))
  const steps = Array.from({ length: 200 }, (_, index) => `s${index}`)
  const result = await tool.execute({
    branchId: 'big',
    flow: { id: 'f', steps: steps.map((id) => ({ id })) },
    branches: [{ id: 'big', kind: 'happy', steps }],
  }, {})
  assert.equal(result.truncated, true)
  assert.ok(result.items.length <= 48)
  assert.equal(result.domain, 'ux-review')
  assert.match(result.summary, /截断/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ux-review',
    target: 'replacement probe',
    candidates: [
      { path: 'checkout/happy/s1' },
      { path: 'checkout/happy/s2' },
      { path: 'checkout/error/s1' },
      { path: 'checkout/error/s4' },
    ],
  }, {})
  // v1 declared the string 'flow'; v2 declares the object form with `resolve`.
  // The object form always applies — that is the migration.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'flow-branch')
  assert.equal(plan.bundleKey.derived, 4)
  assert.equal(plan.bundles.length, 2)
  const happyBundle = plan.bundles.find((item) => item.key === 'checkout/happy')
  assert.ok(happyBundle !== undefined, 'the two candidates of one branch must share one bundle')
  assert.deepEqual(happyBundle.paths.sort(), ['checkout/happy/s1', 'checkout/happy/s2'])
  assert.notEqual(
    resolveBundleKey(pack, { path: 'checkout/happy/s1' }, {}).key,
    resolveBundleKey(pack, { path: 'checkout/error/s1' }, {}).key,
    'two different branches must NOT collide',
  )
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
