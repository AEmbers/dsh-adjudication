/**
 * Contract test — `node contract-test.mjs`. No framework, no dependencies.
 *
 * It proves the claim the acceptance criterion makes: `lib/contracts.js` is
 * importable, exports the five extension-point constants and their validators,
 * and every validator actually rejects what the contract says it must reject.
 * A validator that only ever says "ok" is worse than no validator, so most of
 * the assertions below are NEGATIVE cases.
 *
 * This file is additive: it does not touch smoke-test.mjs or mount-test.mjs and
 * changes none of their outcomes.
 */

import assert from 'node:assert/strict'
import * as contracts from './lib/contracts.js'

let failures = 0
let passes = 0

function test(title, body) {
  try {
    body()
    passes += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${title}`)
    console.log(`       ${error.message}`)
  }
}

const VALID_RULE_DOC = [
  '---',
  'name: error-handling',
  'match:',
  '  - "**/*.go"',
  "  - '**/*.ts'",
  'needs-expert-review: true',
  '---',
  '错误处理：被忽略的 error 返回值、被吞掉的失败分支、只记日志不返回的失败路径。',
].join('\n')

console.log(`\ndsh-adjudication domain-contract v2 test\n${'='.repeat(50)}\n`)

// ---------------------------------------------------------------------------
console.log('surface')
// ---------------------------------------------------------------------------

test('the contract is importable and versioned', () => {
  assert.equal(contracts.CONTRACT_VERSION, 2)
  assert.equal(contracts.CONTRACT_DOC, 'docs/domain-contract-v2.md')
})

test('all five extension points are exported with a full signature block', () => {
  assert.deepEqual(contracts.EXTENSION_POINT_NAMES, [
    'candidateSource', 'anchorVerifier', 'evidenceTools', 'reviewPrompts', 'ruleLibrary',
  ])
  for (const name of contracts.EXTENSION_POINT_NAMES) {
    const point = contracts.EXTENSION_POINTS[name]
    assert.equal(point.field, name)
    for (const key of ['phase', 'file', 'signature', 'returns', 'failure', 'minimalAssertion']) {
      assert.equal(typeof point[key], 'string', `${name}.${key}`)
      assert.ok(point[key].length > 0, `${name}.${key} must not be empty`)
    }
  }
})

test('every extension point exports a validator and a factory', () => {
  assert.deepEqual([
    typeof contracts.validateCandidateSource, typeof contracts.defineCandidateSource,
    typeof contracts.validateAnchorVerifier, typeof contracts.defineAnchorVerifier,
    typeof contracts.validateEvidenceToolkit, typeof contracts.defineEvidenceToolkit,
    typeof contracts.validateReviewPrompts, typeof contracts.defineReviewPrompts,
    typeof contracts.validateRuleLibrary, typeof contracts.defineRuleLibrary,
    typeof contracts.validateDomainPackV2, typeof contracts.defineDomainPackV2,
  ], Array(12).fill('function'))
})

test('the contract constants are internally consistent', () => {
  assert.deepEqual(contracts.checkContractIntegrity(), [])
})

test('every built-in domain has a documented input format and the mandatory fixtures', () => {
  assert.equal(contracts.DOCUMENTED_DOMAIN_IDS.length, 19)
  for (const id of contracts.DOCUMENTED_DOMAIN_IDS) {
    const entry = contracts.DOMAIN_INPUT_FORMATS[id]
    assert.equal(typeof entry.format, 'string', id)
    for (const mandatory of contracts.MANDATORY_FIXTURES) {
      assert.ok(entry.fixtures.includes(mandatory), `${id} is missing the "${mandatory}" fixture`)
    }
  }
  // Only the C family may disclaim bounded enumeration.
  const unbounded = contracts.DOCUMENTED_DOMAIN_IDS.filter((id) => contracts.DOMAIN_INPUT_FORMATS[id].bounded === false)
  assert.deepEqual([...unbounded].sort(), ['market-research', 'reverse-engineering'])
})

// ---------------------------------------------------------------------------
console.log('\nruleLibrary (P3)')
// ---------------------------------------------------------------------------

test('a well-formed rule document parses into the engine Rule shape', () => {
  assert.deepEqual(contracts.validateRuleDocument(VALID_RULE_DOC, 'error-handling.md'), [])
  const rule = contracts.ruleFromDocument(VALID_RULE_DOC, 'error-handling.md')
  assert.equal(rule.name, 'error-handling')
  assert.deepEqual(rule.match, ['**/*.go', '**/*.ts'])
  assert.equal(rule.needsExpertReview, true)
  assert.equal(rule.source, 'error-handling.md')
})

test('the front-matter parser reads scalars, lists and booleans without YAML', () => {
  const parsed = contracts.parseRuleDocument(VALID_RULE_DOC)
  assert.equal(parsed.frontMatter.name, 'error-handling')
  assert.deepEqual(parsed.frontMatter.match, ['**/*.go', '**/*.ts'])
  assert.equal(parsed.frontMatter['needs-expert-review'], true)
  assert.deepEqual(parsed.problems, [])
})

test('a missing front-matter block is rejected, not silently defaulted', () => {
  assert.equal(contracts.validateRuleDocument('just rule prose, no front-matter', 'x.md').length, 1)
  assert.equal(contracts.validateRuleDocument('---\nname: x\n', 'x.md').length, 1, 'unterminated block')
})

test('an agent-drafted library may never claim expert review', () => {
  const claimed = VALID_RULE_DOC.replace('needs-expert-review: true', 'needs-expert-review: false')
  const problems = contracts.validateRuleDocument(claimed, 'x.md')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /needs-expert-review must be exactly true/)
  assert.equal(contracts.RULE_PROVENANCE.expertValidated, false)
  assert.equal(contracts.RULE_PROVENANCE.requiresExpertReview, true)
})

test('a rule library below the per-domain minimum is refused', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    name: `r-${index}`, match: ['**/*.ts'], text: '规则正文足够长以通过校验。', needsExpertReview: true,
  }))
  assert.deepEqual(contracts.validateRuleLibrary({ rules: many }), [], '20 rules is enough')
  const short = contracts.validateRuleLibrary({ rules: many.slice(0, 4) })
  assert.equal(short.length, 1)
  assert.match(short[0], /at least 20/)
})

// ---------------------------------------------------------------------------
console.log('\ncandidateSource (P0)')
// ---------------------------------------------------------------------------

test('a candidate source must enumerate, and its result is shape-checked', () => {
  assert.deepEqual(contracts.validateCandidateSource({ kind: 'diff-hunks', enumerate: () => ({}) }), [])
  assert.equal(contracts.validateCandidateSource({ kind: 'diff-hunks' }).length, 1)
  const clean = { candidates: [{ id: 'a', path: 'src/a.ts', locator: {}, text: 'x' }], excluded: [], notes: [], bounded: true, truncated: false }
  assert.deepEqual(contracts.validateCandidateSetResult(clean), [])
})

test('duplicate ids, empty excerpts and unglobabble paths are caught', () => {
  const problems = contracts.validateCandidateSetResult({
    candidates: [
      { id: 'a', path: 'src/a.ts', locator: {}, text: '' },
      { id: 'a', path: 'b', locator: {}, text: '' },
    ],
    excluded: [],
  })
  assert.equal(problems.length, 3, problems.join('; '))
  assert.ok(problems.some((problem) => /not unique/.test(problem)))
  assert.ok(problems.some((problem) => /is required/.test(problem)))
})

test('a source that overruns maxCandidates is a contract violation, not a truncation', () => {
  const tooMany = {
    candidates: Array.from({ length: 3 }, (_, index) => ({ id: `c${index}`, path: `p${index}`, locator: {}, text: 'x' })),
    excluded: [],
  }
  assert.equal(contracts.validateCandidateSetResult(tooMany, { maxCandidates: 2 }).length, 1)
})

// ---------------------------------------------------------------------------
console.log('\nanchorVerifier (P5)')
// ---------------------------------------------------------------------------

test('an anchored verdict must carry a trusted tier and a 1-based range', () => {
  assert.deepEqual(contracts.validateAnchorVerdict({ status: 'anchored', tier: 'declared-locator', path: 'a.ts', start: 2, end: 2 }), [])
  const untrusted = contracts.validateAnchorVerdict({ status: 'anchored', tier: 'no-match', path: 'a.ts', start: 1, end: 1 })
  assert.equal(untrusted.length, 1)
  assert.match(untrusted[0], /untrusted tier/)
  assert.equal(contracts.validateAnchorVerdict({ status: 'anchored', tier: 'declared-locator', path: 'a.ts', start: 0, end: 0 }).length, 1)
})

test('ambiguity must be reported as unanchored AND list the competing locations', () => {
  assert.equal(contracts.validateAnchorVerdict({ status: 'unanchored', tier: 'relocation-ambiguous' }).length, 1)
  assert.deepEqual(
    contracts.validateAnchorVerdict({ status: 'unanchored', tier: 'relocation-ambiguous', ambiguousIn: ['one.ts', 'two.ts'] }),
    [],
  )
  assert.equal(contracts.validateAnchorVerdict({ status: 'unanchored', tier: 'invented-tier' }).length, 1, 'tier must be declared')
})

test('a descriptor for the model-side anchor claim is exported', () => {
  assert.deepEqual(contracts.ANCHOR_CLAIM_FIELDS.required, ['kind', 'path', 'locator'])
  const claim = contracts.createAnchorClaim('diff-line', 'a.ts', { start: 2 }, 'const x = 1;')
  assert.equal(claim.kind, 'diff-line')
  assert.equal(claim.excerpt, 'const x = 1;')
})

// ---------------------------------------------------------------------------
console.log('\nevidenceTools (P7, bounded)')
// ---------------------------------------------------------------------------

const TOOL = {
  name: 'read_slice',
  description: '读取某个节点在给定范围内的行',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' } },
  limits: { maxLines: 50 },
  execute: () => ({ items: [], truncated: false, provenance: 'node:n1' }),
}

test('an evidence tool without declared limits is inadmissible', () => {
  const problems = contracts.validateEvidenceTool({ ...TOOL, limits: undefined })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /limits is required/)
})

test('declared limits are clamped to the hard ceiling, not trusted', () => {
  const limited = contracts.normaliseEvidenceLimits({ maxLines: 99_999, maxItems: 1 })
  assert.equal(limited.maxLines, contracts.EVIDENCE_LIMITS.hardMaxLines)
  assert.equal(limited.maxItems, 1)
})

test('an empty toolkit is a valid, honest declaration', () => {
  assert.deepEqual(contracts.validateEvidenceToolkit({ tools: [] }), [])
  assert.equal(contracts.validateEvidenceToolkit({}).length, 1, 'tools must be explicit')
})

test('an evidence result must declare truncation and provenance', () => {
  assert.deepEqual(contracts.validateEvidenceResult({ items: [], truncated: false, provenance: 'x' }), [])
  assert.equal(contracts.validateEvidenceResult({ items: [] }).length, 3)
})

test('evidence tool names derive from the domain id', () => {
  assert.equal(contracts.evidenceToolName('code-review', 'read_slice'), 'adjudicate_code_review_evidence_read_slice')
})

// ---------------------------------------------------------------------------
console.log('\nreviewPrompts (P4 + P6)')
// ---------------------------------------------------------------------------

test('both prompt roles are required and their output is strings only', () => {
  assert.deepEqual(contracts.validateReviewPrompts({ review: () => ({}), verify: () => ({}) }), [])
  assert.equal(contracts.validateReviewPrompts({ review: () => ({}) }).length, 1)
  assert.equal(contracts.validatePromptOutput('review', { system: '' }).length, 1)
  assert.deepEqual(contracts.validatePromptOutput('verify', { system: 's', instructions: 'i' }), [])
  assert.equal(contracts.validatePromptOutput('verify', { system: 's' }).length, 1)
})

test('the two prompt roles may not be the same function (P6 is an INDEPENDENT re-check)', () => {
  // CHANGED (t49): layer 1 of the independence gate. A context-free validator
  // cannot render, so identity is what it checks — and identity is enough for the
  // cheapest way to fake an independent review.
  const one = () => ({ system: 'S', rules: 'r', instructions: 'i' })
  const problems = contracts.validateReviewPrompts({ review: one, verify: one })
  assert.equal(problems.length, 1, problems.join('; '))
  assert.match(problems[0], /must be two different functions/u)
  assert.match(problems[0], /INDEPENDENT/u)
  assert.throws(() => contracts.defineReviewPrompts({ review: one, verify: one }), /invalid reviewPrompts/u)

  // Two DIFFERENT functions that return the same text are accepted here, on
  // purpose: no validator can see their output. That shape is layer 2's job
  // (`lib/reasoner.js:runVerify` refuses it with E_P6_NOT_INDEPENDENT, driven by
  // lib/kernel-test.mjs §17).
  assert.deepEqual(contracts.validateReviewPrompts({ review: () => ({ system: 'S' }), verify: () => ({ system: 'S' }) }), [])
})

test('every trusted anchor tier is declared, and the dead alias stays removed', () => {
  for (const tier of contracts.TRUSTED_ANCHOR_TIERS) {
    assert.ok(Object.hasOwn(contracts.ANCHOR_TIERS, tier), `${tier} is trusted but not declared`)
  }
  // t49: `domain-locator` was declared, listed as trusted, and returned by NOTHING
  // (no `domains/<id>/anchor.js`, not the generic ladder). The RUNTIME guard is
  // lib/kernel-test.mjs §16 — "every trusted tier has a real producer"; this pins
  // the decision in the contract test so the two files cannot drift apart.
  assert.equal(Object.hasOwn(contracts.ANCHOR_TIERS, 'domain-locator'), false)
  assert.equal(contracts.TRUSTED_ANCHOR_TIERS.includes('domain-locator'), false)
})

// ---------------------------------------------------------------------------
console.log('\nbundleKey — the v1 -> v2 migration lever')
// ---------------------------------------------------------------------------

test('a legacy string bundleKey keeps v1 behaviour until explicitly opted in', () => {
  const pack = { bundleKey: 'directory' }
  const asShipped = contracts.resolveBundleKey(pack, { path: 'src/deep/a.ts' })
  assert.equal(asShipped.applied, false, 'must not change grouping for the 19 shipped packs')
  assert.equal(asShipped.key, 'src/deep/a.ts', 'falls back to entry.key ?? entry.path')

  const optedIn = contracts.resolveBundleKey(pack, { path: 'src/deep/a.ts' }, { trustDeclaredStrategies: true })
  assert.equal(optedIn.applied, true)
  assert.equal(optedIn.key, 'src')
})

test('the v2 object form is applied, and an unknown strategy never silently applies', () => {
  const v2 = contracts.resolveBundleKey({ bundleKey: { strategy: 'directory', depth: 2 } }, { path: 'src/deep/a.ts' })
  assert.equal(v2.applied, true)
  assert.equal(v2.key, 'src/deep')

  const unknown = contracts.resolveBundleKey({ bundleKey: { strategy: 'nope' } }, { path: 'a.ts' })
  assert.equal(unknown.applied, false)
  assert.match(unknown.reason, /unknown bundle-key strategy/)
})

test('a pack that declares nothing behaves exactly as today', () => {
  const result = contracts.resolveBundleKey({}, { path: 'a.ts', key: 'explicit' })
  assert.equal(result.applied, false)
  assert.equal(result.key, 'explicit')
})

// ---------------------------------------------------------------------------
console.log('\ncriticism.kind and the v2 pack gate')
// ---------------------------------------------------------------------------

test('the declared kind must agree with the loss orientation', () => {
  assert.equal(contracts.expectedCriticismKind('recall-first'), 'triage')
  assert.equal(contracts.expectedCriticismKind('precision-first'), 'fact-checker')
  assert.equal(contracts.criticismKindConsistent('recall-first', 'triage'), true)
  assert.equal(contracts.criticismKindConsistent('recall-first', 'fact-checker'), false)
})

const V2_PACK = {
  contractVersion: 2,
  id: 'demo-domain',
  title: '演示领域',
  category: 'A',
  lossOrientation: 'precision-first',
  anchor: { kind: 'diff-line', verify: 'engine-recomputable' },
  candidateSet: { kind: 'diff-hunks', inputFormat: 'unified-diff' },
  candidateSource: { kind: 'diff-hunks', inputFormat: 'unified-diff', enumerate: () => ({}) },
  anchorVerifier: { kind: 'diff-line', verify: () => ({}) },
  evidenceTools: { tools: [] },
  reviewPrompts: { review: () => ({}), verify: () => ({}) },
  ruleLibrary: {
    rules: Array.from({ length: 20 }, (_, index) => ({
      name: `rule-${index}`, match: ['**/*.ts'], text: '规则正文足够长以通过校验。', needsExpertReview: true,
    })),
  },
  criticism: { kind: 'fact-checker' },
  bundleKey: { strategy: 'directory' },
  fixtures: ['empty', 'all-gated-out', 'happy-path'],
}

test('a complete v2 pack validates clean', () => {
  assert.deepEqual(contracts.validateDomainPackV2(V2_PACK), [])
})

test('the v2 gate catches each missing extension point', () => {
  for (const field of contracts.REQUIRED_EXTENSION_POINTS) {
    const problems = contracts.validateDomainPackV2({ ...V2_PACK, [field]: undefined })
    assert.ok(problems.length > 0, `removing ${field} must be caught`)
  }
  assert.ok(contracts.validateDomainPackV2({ ...V2_PACK, contractVersion: 1 }).some((problem) => /contractVersion/.test(problem)))
})

test('the v2 gate catches kind drift between anchor, candidateSet and their implementations', () => {
  const anchorDrift = contracts.validateDomainPackV2({ ...V2_PACK, anchorVerifier: { kind: 'other', verify: () => ({}) } })
  assert.ok(anchorDrift.some((problem) => /anchorVerifier.kind/.test(problem)))
  const sourceDrift = contracts.validateDomainPackV2({ ...V2_PACK, candidateSource: { kind: 'other', enumerate: () => ({}) } })
  assert.ok(sourceDrift.some((problem) => /candidateSource.kind/.test(problem)))
})

test('the v2 gate refuses a rule library that is still a seed', () => {
  const seed = contracts.validateDomainPackV2({ ...V2_PACK, ruleLibrary: { rules: V2_PACK.ruleLibrary.rules.slice(0, 4) } })
  assert.ok(seed.some((problem) => /at least 20/.test(problem)))
})

test('the v2 gate refuses a contradictory criticism kind and a legacy bundleKey', () => {
  const contradiction = contracts.validateDomainPackV2({ ...V2_PACK, lossOrientation: 'recall-first' })
  assert.ok(contradiction.some((problem) => /disagrees with lossOrientation/.test(problem)))
  const legacyKey = contracts.validateDomainPackV2({ ...V2_PACK, bundleKey: 'directory' })
  assert.ok(legacyKey.some((problem) => /v2 object form/.test(problem)))
})

test('the v2 gate requires the two boundary fixtures', () => {
  const problems = contracts.validateDomainPackV2({ ...V2_PACK, fixtures: ['happy-path'] })
  assert.ok(problems.some((problem) => /"empty"/.test(problem)))
  assert.ok(problems.some((problem) => /"all-gated-out"/.test(problem)))
})

// ---------------------------------------------------------------------------
console.log('\nfixtures')
// ---------------------------------------------------------------------------

test('a fixture must state an expectation and match the domain input format', () => {
  const good = { name: 'empty', domain: 'demo-domain', format: 'unified-diff', input: { format: 'unified-diff', payload: {} }, expect: { candidates: 0 } }
  assert.deepEqual(contracts.validateFixture(good, 'unified-diff'), [])
  const mismatch = contracts.validateFixture({ ...good, format: 'clause-and-surface' }, 'unified-diff')
  assert.equal(mismatch.length, 2, mismatch.join('; '))
  assert.equal(contracts.validateFixture({ ...good, expect: {} }).length, 2, 'an empty expect fails twice: no field and no stated outcome')
})

test('a fixture with anchors must carry both a positive and a negative case', () => {
  const base = { name: 'empty', domain: 'demo-domain', format: 'unified-diff', input: { format: 'unified-diff', payload: {} }, expect: { candidates: 0 } }
  assert.ok(contracts.validateFixture({ ...base, anchors: { positive: [{ excerpt: 'x' }] } }).some((problem) => /negative/.test(problem)))
  assert.deepEqual(
    contracts.validateFixture({ ...base, anchors: { positive: [{ excerpt: 'x' }], negative: [{ excerpt: 'y' }] } }),
    [],
  )
})

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
