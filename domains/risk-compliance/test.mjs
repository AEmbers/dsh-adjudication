/**
 * risk-compliance — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  one candidate per (clause, surface) binding
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey                  ->  real grouping BY CLAUSE, not by path
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  DUAL anchors; either half missing = unanchored
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
 *    p4.system)` is load-bearing: the validators do NOT check it, so without
 *    this assertion a domain could pass `validateDomainPackV2` while handing its
 *    reviewer its own reasoning back.
 * 3. It never asserts coverage from a SELF-REPORTED anchor. Every anchor used in
 *    the end-to-end part is produced by this domain's own `anchor.verify()` over
 *    real material first, and the numbers are derived from those verdicts. (This
 *    is also what actually exercises `anchor.js` rather than bypassing it.)
 *
 * Usage: `node domains/risk-compliance/test.mjs`
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
  critique,
  gate,
  report,
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { loadDomain, loadDomains, createNodeIo } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack from './index.js'
import source, { surfacePath } from './source.js'
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

const inputPayload = (name) => {
  const value = fixture(name)
  return { input: { format: value.input.format, payload: value.input.payload }, gate: value.gate ?? {} }
}

/** Enumerate + gate one fixture. The source never applies the gate itself. */
function runP0P1(name) {
  const { input, gate: overrides } = inputPayload(name)
  const context = { maxCandidates: 400, maxExcerptLines: 500 }
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

const countByClause = (candidates) => {
  const counts = {}
  for (const candidate of candidates) {
    const id = candidate.meta?.clauseId ?? '(none)'
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\nrisk-compliance domain — contract v2 end-to-end')
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
  const declared = inputFormatFor('risk-compliance')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(declared.format, 'clause-and-surface')
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(declared.bounded, true)
  assert.equal(source.bounded, true)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.kind, 'clause-and-evidence')
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable', 'this anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('this domain is recall-first and its reviewer shape agrees', () => {
  assert.equal(pack.lossOrientation, 'recall-first', 'compliance misses cost far more than false positives')
  assert.equal(pack.criticism.kind, 'triage')
  assert.ok(pack.protectedSubjects.includes('security'))
  assert.ok(pack.protectedSubjects.includes('privacy'))
  assert.ok(pack.protectedSubjects.includes('safety'))
  assert.ok(pack.protectedSubjects.includes('data-loss'))
  assert.ok(pack.protectedSubjects.includes('legal'))
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.ok(evidence.tools.length > 0, 'a toolkit with no tools would be admissible but useless here')
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxLines > 0 && tool.limits.maxItems > 0 && tool.limits.maxCalls > 0,
      `${tool.name} must declare positive limits`)
    assert.ok(tool.limits.maxLines <= 2000 && tool.limits.maxItems <= 1000, `${tool.name} must stay under the hard ceilings`)
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

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'sql-only', match: ['**/*.sql'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**'], text: 'y'.repeat(20) },
  ], ['service/auth/check.ts'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('rule selection over the real library injects the glob-matching rules, and only those', () => {
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = /^name:\s*(.+)$/mu.exec(text)?.[1]?.trim()
    const match = [...text.matchAll(/^\s+- "(.+)"$/gmu)].map((hit) => hit[1])
    return { name, match, text: 'body' }
  })
  const { injected } = selectRules(rules, ['service/auth/check.ts'])
  const names = injected.map((rule) => rule.name)
  assert.ok(names.includes('logging-pii'), 'a rule matching *.ts must be injected for a .ts surface')
  assert.ok(!names.includes('vendor-and-subprocessor-register'), 'a rule restricted to *.md must NOT be injected for a .ts surface')
  assert.ok(!names.includes('consent-record-keeping'), 'a rule restricted to sql/json/yaml must NOT be injected for a .ts surface')
  assert.equal(new Set(names).size, names.length, 'no rule may be injected twice')
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  assert.ok(FIXTURES.has('unmatched-clause'), 'this domain must ship the class the contract table names')
})

test('every fixture declares anchors with both positive and negative cases', () => {
  for (const [name, value] of FIXTURES) {
    assert.ok(value.anchors, `${name} must declare anchors`)
    assert.ok(value.anchors.positive?.length > 0, `${name} needs a positive anchor case`)
    assert.ok(value.anchors.negative?.length > 0, `${name} needs a negative anchor case`)
  }
  const allNegatives = [...FIXTURES.values()].flatMap((value) => value.anchors.negative ?? [])
  assert.ok(allNegatives.some((entry) => /no-match|locator-mismatch/u.test(entry.expectTier)),
    'at least one negative must be a refused paraphrase/contradiction')
  assert.ok(allNegatives.some((entry) => entry.expectTier === 'relocation-ambiguous'),
    'at least one negative must be a refused cross-file ambiguity')
})

// ---------------------------------------------------------------------------
// P0 / P1 — the three boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — empty / all-gated-out / admitted')

test('boundary: an empty clause register and an empty surface list produce an EMPTY candidate set', () => {
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
  assert.equal(empty.enumerated.candidates.length, 0, 'empty: P0 produced nothing')
  assert.equal(empty.result.excluded.length, 0)
  assert.ok(gatedOut.enumerated.candidates.length > 0, 'all-gated-out: P0 produced something')
  assert.ok(gatedOut.result.excluded.length > 0, 'all-gated-out: P1 removed it')
})

test('happy path: every (clause, surface) binding is admitted, and the per-clause split is real', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
  assert.deepEqual(countByClause(enumerated.candidates), expected.clauseCounts)
})

test('a clause whose appliesTo matches no surface is REPORTED, not silently dropped', () => {
  const expected = fixture('unmatched-clause').expect
  const { enumerated, result } = runP0P1('unmatched-clause')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  const orphan = enumerated.excluded.find((entry) => entry.id === 'ORPHAN-02')
  assert.ok(orphan !== undefined, 'the unmatched clause must appear in excluded')
  assert.equal(orphan.reason, expected.excludedBySource['ORPHAN-02'])
})

test('the gate is the engine\'s ordered predicate list, and the pack only narrows it', () => {
  assert.deepEqual(gate([], {}).ordered, DEFAULT_GATE_PREDICATES.map(([label]) => label))
  assert.deepEqual(pack.gate.exclude, ['**/.git/**', '**/dist/**', '**/build/**', '**/*.md'])
  for (const pattern of pack.gate.exclude) {
    assert.ok(DEFAULT_EXCLUDE_PATTERNS.includes(pattern) || pattern === '**/build/**' || pattern === '**/*.md',
      `"${pattern}" is not one of the engine's default patterns — justify it or drop it`)
  }
  assert.ok(!pack.gate.exclude.includes('**/node_modules/**'), 'node_modules is covered by default-path')
})

test('a candidate larger than the ceiling is removed by the too-large predicate', () => {
  const result = gate([{ path: 'service/huge.ts', bytes: 4096 }], { exclude: pack.gate.exclude, maxFileBytes: 1024 })
  assert.deepEqual(result.selected, [])
  assert.equal(result.excluded[0].predicate, 'too-large')
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ clauses: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ surface: 42 }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ clauses: [], surface: [] }, {}))
})

test('candidate ids are unique, paths are gate-globable, and every candidate carries the dual locator', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.match(candidate.path, /^[a-z0-9][a-z0-9._:/-]*$/u, `${candidate.id} path must be globbable`)
    assert.equal(typeof candidate.locator.clauseId, 'string', `${candidate.id} needs the RULE half of the dual anchor`)
    assert.equal(typeof candidate.locator.surfaceId, 'string', `${candidate.id} needs the EVIDENCE half of the dual anchor`)
    assert.ok(String(candidate.text).includes('可抄写证据'), `${candidate.id} must carry the quotable material`)
  }
})

test('the source reports skipped/malformed items rather than dropping them', () => {
  const enumerated = source.enumerate({
    clauses: [{ id: 'C-1', title: 't', text: 'x', appliesTo: ['**'] }, { title: 'no id', text: 'y' }],
    surface: [{ id: 's-1', description: 'd', evidence: 'e' }, 'not-an-object'],
  }, {})
  assert.equal(enumerated.candidates.length, 1)
  const reasons = enumerated.excluded.map((entry) => entry.reason)
  assert.ok(reasons.some((reason) => /条款缺少 id/u.test(reason)), JSON.stringify(reasons))
  assert.ok(reasons.some((reason) => /不是对象/u.test(reason)), JSON.stringify(reasons))
})

test('a surface with no declared path gets a synthetic identity, scoped by its clause', () => {
  const enumerated = source.enumerate({
    clauses: [{ id: 'C 1', title: 't', text: 'x' }],
    surface: [{ id: 'No Path Here', description: 'd', evidence: 'e' }],
  }, {})
  assert.equal(enumerated.candidates.length, 1)
  assert.equal(surfacePath({ id: 'No Path Here' }), 'surface/no-path-here')
  assert.equal(enumerated.candidates[0].path, `c-1/${surfacePath({ id: 'No Path Here' })}`)
  assert.equal(enumerated.candidates[0].meta.clauseId, 'C 1')
  assert.equal(enumerated.candidates[0].meta.clauseScope, 'c-1')
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling by clause (not by path)')

test('bundleKey resolves through the contract helper and is APPLIED', () => {
  const { result } = runP0P1('happy-path')
  const resolutions = result.selected.map((entry) => resolveBundleKey(pack, entry, {}))
  for (const resolution of resolutions) {
    assert.equal(resolution.applied, true, resolution.reason)
    assert.equal(resolution.source, 'derived')
    assert.equal(resolution.strategy, 'clause')
  }
})

test('the multi-clause change really splits into one bundle PER CLAUSE', () => {
  const expected = fixture('happy-path').expect
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: resolveBundleKey(pack, entry, {}).key }))
  const bundled = bundle(keyed)
  const keys = bundled.bundles.map((item) => item.key).sort()
  assert.deepEqual(keys, expected.bundleKeys)
  assert.ok(keys.length > 1, 'one bundle would mean P2 was decorative')
  assert.notEqual(bundled.strategy, 'short-circuit-single')
})

test('two candidates that must share a clause DO land in one bundle (not just applied:true)', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: resolveBundleKey(pack, entry, {}).key }))
  const bundled = bundle(keyed)

  const dp = bundled.bundles.find((item) => item.key === 'dp-01')
  assert.ok(dp !== undefined, 'the DP-01 clause must form its own bundle')
  assert.equal(dp.entries.length, 5)
  // Every entry in that bundle is there BECAUSE of the clause, and they are all
  // different paths — this is the property `{ strategy: 'path' }` would destroy.
  assert.equal(new Set(dp.entries.map((entry) => entry.meta.clauseId)).size, 1)
  assert.equal(new Set(dp.entries.map((entry) => entry.path)).size, 5)

  // And no bundle ever mixes two different clauses.
  for (const item of bundled.bundles) {
    assert.equal(new Set(item.entries.map((entry) => entry.meta.clauseId)).size, 1,
      `bundle "${item.key}" mixed clauses: ${item.entries.map((entry) => entry.meta.clauseId).join(' | ')}`)
  }
})

// ---------------------------------------------------------------------------
// P5 — the anchor verifier, positive and negative
// ---------------------------------------------------------------------------

console.log('\nP5 — dual anchors (the hard constraint)')

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
      if (entry.expectClause !== undefined) assert.equal(verdict.clause, entry.expectClause,
        'an anchored dual verdict must name the clause half it recomputed')
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
      assert.equal(verdict.clause, null)
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
      if (entry.expectAmbiguousIn !== undefined) {
        assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
      }
    })
  }
}

// --- the dual anchor, half by half -----------------------------------------

const DUAL_SUBJECT = {
  path: 'service/profile/read.ts',
  clauses: [{ id: 'DP-01', title: '数据最小化', text: '超出必要的处理即为问题。' }],
  documents: [
    { path: 'service/profile/read.ts', content: 'export async function getProfile(uid) {\n  const row = await db.user.findOne({ where: { uid } })\n  return { uid, phone: row.phone }\n}\n' },
  ],
}
const VERBATIM = '  const row = await db.user.findOne({ where: { uid } })'

test('DUAL ANCHOR: the rule half alone is NOT an anchor (no quotable evidence)', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01' }, excerpt: '' },
    DUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'empty-excerpt')
})

test('DUAL ANCHOR: the evidence half alone is NOT an anchor (no clause)', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: {}, excerpt: VERBATIM },
    DUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /条款/u)
})

test('DUAL ANCHOR: both halves present and consistent DO anchor', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01' }, excerpt: VERBATIM },
    DUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'recomputed-unique')
  assert.equal(verdict.clause, 'DP-01')
  assert.equal(verdict.start, 2)
})

test('DUAL ANCHOR: a clause id the register does not contain is refused, never approximated', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-99' }, excerpt: VERBATIM },
    DUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /DP-99/u)
})

test('DUAL ANCHOR: a (clause, surface) binding absent from the candidate set is refused', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01', surfaceId: 'svc-export-upload' }, excerpt: VERBATIM },
    { ...DUAL_SUBJECT, candidates: [{ id: 'DP-01@svc-profile-read', path: 'service/profile/read.ts', meta: { clauseId: 'DP-01', surfaceId: 'svc-profile-read' } }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /绑定/u)
})

test('a paraphrase never anchors, even when the intent is obvious', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01' }, excerpt: 'const row = await db.user.findByUid(uid)' },
    DUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01', startLine: 99 }, excerpt: VERBATIM },
    DUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('indentation is tolerated; punctuation is not', () => {
  const tolerated = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01' }, excerpt: 'const row   =   await db.user.findOne({where:{uid}})' },
    DUAL_SUBJECT,
  )
  assert.equal(tolerated.status, 'anchored')

  const punctuation = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01' }, excerpt: 'const row = await db.user.findOne({ where: { uid: uid } })' },
    DUAL_SUBJECT,
  )
  assert.equal(punctuation.status, 'unanchored', 'a changed expression is a changed line')
})

test('a cross-file relocation must be unique, and the competing locations are listed', () => {
  const documents = [
    { path: 'service/one.ts', content: 'const shared = 1\n' },
    { path: 'service/two.ts', content: 'const shared = 1\n' },
  ]
  const ambiguous = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/missing.ts', locator: { clauseId: 'DP-01' }, excerpt: 'const shared = 1' },
    { path: 'service/missing.ts', clauses: DUAL_SUBJECT.clauses, documents },
  )
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['service/one.ts:1', 'service/two.ts:1'])

  const unique = anchor.verify(
    { kind: 'clause-and-evidence', path: 'service/missing.ts', locator: { clauseId: 'DP-01' }, excerpt: 'const shared = 1' },
    { path: 'service/missing.ts', clauses: DUAL_SUBJECT.clauses, documents: [documents[0]] },
  )
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
  assert.equal(unique.path, 'service/one.ts')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'service/profile/read.ts', locator: { clauseId: 'DP-01' }, excerpt: VERBATIM },
    DUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'clause-and-evidence' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'clause-and-evidence', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['service/auth/check.ts'],
  bundle: { key: 'AC-03', paths: ['service/auth/check.ts'], rules: ['access-control-least-privilege'] },
  ruleText: '<rules path="service/auth/check.ts">\n访问控制：内网即可信属于越权。\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', clauseId: 'AC-03', path: 'service/auth/check.ts', evidence: 'if (isPrivateNetwork(req.ip)) return { allowed: true }', message: '内网来源被隐式信任', defended: true },
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
  assert.doesNotMatch(P6.system, /本轮负责的受监管面/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /访问控制/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /访问控制：内网即可信/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts repeat the DUAL anchor law: clause id AND verbatim text, never a line number', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /锚点/u)
  }
  assert.match(P4.system, /双锚点/u)
  assert.match(P4.system, /不要输出行号/u)
  assert.match(P4.system, /条款 ID/u)
  assert.match(P6.system, /条款/u)
})

test('the recall-first loss sentence is stated, and it says doubtful items are KEPT', () => {
  assert.match(P4.system, /recall-first/u)
  assert.match(P4.system, /存疑即保留/u)
  assert.match(P6.system, /recall-first/u)
  assert.match(P6.system, /正面否定/u)
  assert.match(P6.system, /undecided/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
})

test('every orientation gets its own loss sentence, so the pack cannot be silently flipped', () => {
  const precision = prompts.review({ ...reviewContext, orientation: 'precision-first' })
  assert.notEqual(precision.system, P4.system)
  assert.match(precision.system, /precision-first/u)
  const flipped = prompts.verify({ ...verifyContext, orientation: 'precision-first' })
  assert.notEqual(flipped.system, P6.system)
})

test('the prompts tell the model the rule library is NOT expert-validated', () => {
  assert.match(P4.system, /needs-expert-review/u)
  assert.match(P4.system, /未经领域专家审定/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const DOCS = [
  { path: 'service/a.ts', content: 'line1\nline2\nneedle here\nline4\n' },
  { path: 'data/b.sql', content: 'needle also here\n' },
]
const CLAUSES = [
  { id: 'DP-01', title: '数据最小化', text: '超出必要的处理即为问题。' },
  { id: 'LG-05', title: '日志与审计', text: '日志中是否出现明文个人信息。' },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('read_surface returns at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('read_surface')
  const big = { path: 'service/big.ts', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 'service/big.ts', start: 1, documents: [big] }, {})
  assert.ok(result.items.length <= tool.limits.maxLines, `${result.items.length} > ${tool.limits.maxLines}`)
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.ok(result.provenance.length > 0)
})

await testAsync('read_surface does not truncate when the request fits', async () => {
  const tool = toolByName('read_surface')
  const result = await tool.execute({ path: 'service/a.ts', start: 2, end: 3, documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => item.line), [2, 3])
  assert.equal(result.truncated, false)
})

await testAsync('search_clauses caps its hit count, reports the cap, and is honest that it is literal', async () => {
  const tool = toolByName('search_clauses')
  const many = Array.from({ length: 150 }, (_, index) => ({ id: `C-${index}`, title: 't', text: 'needle 出现在这里' }))
  const result = await tool.execute({ pattern: 'needle', clauses: many }, {})
  assert.ok(result.items.length <= tool.limits.maxItems)
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
  assert.match(result.provenance, /非语义检索/u)
})

await testAsync('search_clauses finds the rule side and says which clause', async () => {
  const tool = toolByName('search_clauses')
  const result = await tool.execute({ pattern: '明文个人信息', clauses: CLAUSES }, {})
  assert.deepEqual(result.items.map((item) => item.id), ['LG-05'])
  assert.equal(result.truncated, false)
})

await testAsync('list_bindings refuses to answer when no candidate set was injected', async () => {
  const tool = toolByName('list_bindings')
  assert.throws(() => tool.execute({}, {}), /缺少 `candidates`/u)
})

await testAsync('list_bindings lists the enumerated bindings and filters by clause', async () => {
  const tool = toolByName('list_bindings')
  const enumerated = runP0P1('happy-path').enumerated.candidates
  const all = await tool.execute({ candidates: enumerated }, {})
  assert.equal(all.items.length, 22)
  const dp = await tool.execute({ candidates: enumerated, clauseId: 'DP-01' }, {})
  assert.equal(dp.items.length, 5)
  assert.ok(dp.items.every((item) => item.clauseId === 'DP-01'))
})

await testAsync('a request naming an absent document fails loudly with the available paths', async () => {
  const tool = toolByName('read_surface')
  assert.throws(() => tool.execute({ path: 'service/nope.ts', documents: DOCS }, {}),
    /文档集里没有 "service\/nope\.ts"/u)
})

await testAsync('a request with no documents at all is refused, not answered with "nothing found"', async () => {
  const tool = toolByName('read_surface')
  assert.throws(() => tool.execute({ path: 'service/a.ts' }, {}), /缺少 `documents`/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('risk-compliance', 'read_surface'), 'adjudicate_risk_compliance_evidence_read_surface')
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
                clauseId: 'DP-01',
                path: 'service/profile/read.ts',
                evidence: 'export async function getProfile(uid) {',
                message: '资料读取返回了全部字段',
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
  assert.equal(outcome.rounds, bundled.bundles.length, 'one bounded pass per bundle')
  assert.equal(outcome.findings.length, bundled.bundles.length, 'every pass reported the same single finding')
  assert.ok(requests.length >= 1, 'the reasoner must actually call the child')
  assert.match(requests[0].prompt[0].text, /风控合规监察/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /双锚点/u, 'the dual-anchor law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('recall-first keeps the doubtful finding and drops only the positively disproved one', () => {
  const panel = runCritiquePanel([
    { id: 'doubtful', path: 'service/a.ts', severity: 'medium', evidence: '', defended: false },
    { id: 'disproved', path: 'service/b.ts', severity: 'medium', evidence: 'x', defended: false, disproved: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['doubtful'], 'a doubtful item must survive recall-first')
  assert.deepEqual(panel.dropped.map((item) => item.id), ['disproved'])
  assert.equal(panel.kind, 'triage')
})

test('a protected subject vetoes BEFORE the correctness judgement, in both orientations', () => {
  const veto = critique(
    { id: 'v', path: 'service/a.ts', subject: 'privacy', severity: 'info', evidence: '', defended: false },
    { orientation: 'precision-first', kind: 'fact-checker' },
  )
  assert.equal(veto.keep, true, 'a privacy finding must not be dropped for lack of proof')
  assert.equal(veto.vetoed, true)
  const panel = runCritiquePanel([
    { id: 'v', path: 'service/a.ts', subject: 'data-loss', severity: 'low', evidence: '' },
  ], { orientation: 'precision-first', kind: 'fact-checker', protectedSubjects: pack.protectedSubjects })
  assert.equal(panel.kept.length, 1)
  assert.equal(panel.vetoes, 1)
})

test('precision-first, by contrast, drops exactly the same doubtful item', () => {
  const panel = runCritiquePanel([
    { id: 'doubtful', path: 'service/a.ts', severity: 'medium', evidence: '', defended: false },
  ], { orientation: 'precision-first', kind: 'fact-checker' })
  assert.deepEqual(panel.kept, [])
  assert.equal(panel.dropped.length, 1)
})

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(5, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 5)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, 0.4)
  assert.equal(proof.complete, false)
})

test('recall-first: an incomplete coverage proof is marked NOT PASSED, with real numbers', () => {
  const proof = coverage(22, [{ path: 'service/a.ts' }, { path: 'data/b.ts' }], { requireComplete: true })
  assert.equal(proof.total, 22)
  assert.equal(proof.reviewed, 2)
  assert.equal(proof.coverageRate, Number((2 / 22).toFixed(4)))
  assert.equal(proof.complete, false)
  assert.equal(proof.required, true, 'recall-first declarations must demand completeness')
  assert.notEqual(proof.coverageRate, 1)
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([
    { id: 'f', path: 'service/a.ts', start: 1, severity: 'high', evidence: 'x', defended: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind, protectedSubjects: pack.protectedSubjects })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 22, excluded: 0, bundles: 5 },
    findings: panel.kept,
    coverageProof: coverage(22, panel.kept, { requireComplete: true }),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'risk-compliance')
  assert.equal(built.lossOrientation, 'recall-first')
  assert.equal(built.criticismKind, 'triage')
  assert.equal(built.coverage.total, 22)
  assert.equal(built.coverage.reviewed, 1)
  assert.equal(built.coverage.coverageRate, Number((1 / 22).toFixed(4)))
  assert.equal(built.coverage.complete, false)
  assert.equal(built.generatedAt, null, 'a deterministic engine must not stamp wall-clock time')
})

// ---------------------------------------------------------------------------
// The domain as loaded from disk
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: 'risk-compliance', dir: 'domains/risk-compliance' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'regulated-surface')
  assert.equal(assembled.anchorVerifier.kind, 'clause-and-evidence')
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
  const mine = result.packs.find((item) => item.id === 'risk-compliance')
  assert.ok(mine !== undefined, `risk-compliance must load; problems: ${JSON.stringify(result.problems)}`)
  assert.equal(mine.id, 'risk-compliance')
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
    domain: 'risk-compliance',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'regulated-surface')
  assert.equal(plan.candidateSet.inputFormat, 'clause-and-surface')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.strategy, 'clause')
  assert.equal(plan.bundleKey.derived, plan.gate.admitted, 'every admitted candidate must have gone through the resolver')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundles.length, 5, 'a five-clause input must form five bundles — one per instrument clause')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), happy.expect.bundleKeys)
  const dp = plan.bundles.find((item) => item.key === 'dp-01')
  assert.ok(dp !== undefined, 'the DP-01 clause must form its own bundle')
  assert.equal(dp.paths.length, 5, 'all five surfaces of DP-01 must be judged together')
  assert.equal(new Set(dp.paths).size, 5, 'and they must be five DIFFERENT surfaces, not one repeated')
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'risk-compliance',
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
    domain: 'risk-compliance',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})

  assert.equal(plan.gate.admitted, 0)
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'all-00/config/.env': 'secret',
    'all-00/data/retired/policy.ts': 'deleted',
    'all-00/node_modules/leftpad/index.js': 'default-path',
    'all-00/policy/retention-memo.md': 'user-exclude',
    'all-00/service/export/full-dump.ts': 'too-large',
    'all-00/service/payments/flow.ts': 'binary',
    'all-00/vendor/legacy/sync.ts': 'default-path',
  })
  assert.equal(plan.gate.excluded.length, 7)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /排除 7 项/u)
})

await testAsync('P0 -> P7 round trip: anchors come from the DOMAIN verifier, and the rate follows them', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const payload = happy.input.payload

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'risk-compliance',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload },
  }, {})

  // Recompute the candidate set so the claims can be built from REAL material.
  const enumerated = source.enumerate(payload, { maxCandidates: 400, maxExcerptLines: 500 })
  const documents = enumerated.candidates.map((candidate) => ({
    path: candidate.path,
    content: String(payload.surface.find((entry) => entry.id === candidate.meta.surfaceId)?.evidence ?? ''),
  }))
  assert.ok(documents.length >= 3)
  const clauses = payload.clauses.map((clause) => ({ id: clause.id, title: clause.title, text: clause.text }))

  const anchoredFindings = []
  for (const candidate of enumerated.candidates.slice(0, 3)) {
    const surface = payload.surface.find((entry) => entry.id === candidate.meta.surfaceId)
    const lines = String(surface.evidence).split('\n')
    const excerpt = lines[lines.length - 1]
    const verdict = anchor.verify({
      kind: 'clause-and-evidence',
      path: candidate.path,
      locator: { clauseId: candidate.locator.clauseId },
      excerpt,
    }, { path: candidate.path, clauses, candidates: enumerated.candidates, documents })
    assert.equal(verdict.status, 'anchored', `${candidate.id} must anchor through the domain verifier: ${verdict.detail}`)
    assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier))
    anchoredFindings.push({
      id: candidate.id,
      path: verdict.path,
      // CHANGED (t22): `clauseId` used to sit at the TOP LEVEL of the finding.
      // It never reached the domain verifier. `recomputeAnchor`
      // (index.js:755-762) passes `finding.locator` through VERBATIM and folds
      // the top-level `start`/`end` convenience fields into it only when the
      // caller supplied no locator at all — so a top-level `clauseId` was
      // silently dropped, every submission came back unanchored with
      // `no-documents`, `coverage.reviewed` measured 0, and the old
      // `assert.ok(reviewed <= 3)` was therefore true for entirely the wrong
      // reason. The domain key belongs in `locator`.
      locator: { clauseId: candidate.locator.clauseId, surfaceId: candidate.meta.surfaceId },
      severity: 'high',
      message: `${candidate.locator.clauseId} 管辖 ${candidate.meta.surfaceId}`,
      excerpt,
      evidence: excerpt,
      defended: true,
    })
  }
  assert.equal(anchoredFindings.length, 3)

  // A fourth finding whose "evidence" is a paraphrase of the same material. The
  // domain verifier refuses it, and the submission must count it as unanchored —
  // an assertion that holds whether or not the engine re-verifies anchors itself.
  const paraphrase = anchor.verify({
    kind: 'clause-and-evidence',
    path: enumerated.candidates[0].path,
    locator: { clauseId: enumerated.candidates[0].locator.clauseId },
    excerpt: '大概是说资料读取会返回手机号之类的东西',
  }, { path: enumerated.candidates[0].path, clauses, candidates: enumerated.candidates, documents })
  assert.equal(paraphrase.status, 'unanchored')

  const paraphraseFinding = {
    id: 'f-paraphrase',
    path: enumerated.candidates[0].path,
    locator: { clauseId: enumerated.candidates[0].locator.clauseId, surfaceId: enumerated.candidates[0].meta.surfaceId },
    severity: 'high',
    message: '转述而非抄写',
    excerpt: '大概是说资料读取会返回手机号之类的东西',
    evidence: '大概是说资料读取会返回手机号之类的东西',
  }

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'risk-compliance',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    // CHANGED (t22): `documents` is REQUIRED for the engine to recompute the
    // evidence side — `recomputeAnchor` looks the finding's path up in this
    // list (index.js:768) and hands the content to the domain verifier. Without
    // it the verifier reports `no-documents` and nothing can ever anchor. The
    // tool description said so all along; the old test never passed it.
    documents,
    findings: [...anchoredFindings, paraphraseFinding],
  }, {})

  assert.equal(submitted.coverage.total, plan.gate.admitted, 'total is the gate\'s admitted count, not a number picked to look complete')
  assert.equal(submitted.coverage.required, true, 'recall-first must require completeness')
  assert.equal(submitted.coverage.complete, false, '22 admitted surfaces were not covered')
  assert.equal(submitted.coverage.coverageRate, Number((submitted.coverage.reviewed / plan.gate.admitted).toFixed(4)))
  // CHANGED (t22): this was `assert.ok(submitted.coverage.reviewed <= 3)`.
  // That bound is satisfied by 0 — and 0 is what it actually measured, because
  // the engine rejected all four findings. A vacuous upper bound is worse than
  // no assertion: it stays green while the coverage proof proves nothing. The
  // exact number is asserted now, and it is 3 only because the engine re-ran
  // this domain's own verifier and anchored exactly three findings.
  assert.equal(submitted.coverage.reviewed, 3,
    `exactly the three really-anchored findings may count (got ${submitted.coverage.reviewed})`)
  assert.equal(submitted.coverage.coverageRate, Number((3 / plan.gate.admitted).toFixed(4)),
    'the rate is reviewed/total with the counted number, not a number of its own')
  assert.equal(submitted.anchorVia, 'anchorVerifier', 'the domain verifier is the path that ran, not a generic fallback')
  assert.equal(submitted.findings.length, 3, 'all three anchored findings survive the recall-first panel')
  // CHANGED (t22): this was `assert.ok(submitted.unanchored >= 1)`, which is
  // ALSO satisfied by "all four were unanchored" — the same vacuum. Assert the
  // exact count, then assert something that actually separates the two states.
  assert.equal(submitted.unanchored, 1, `exactly the paraphrase is unanchored (got ${submitted.unanchored})`)
  assert.deepEqual(
    submitted.unanchoredDetails.map((item) => ({ id: item.id, tier: item.tier, via: item.via })),
    [{ id: 'f-paraphrase', tier: 'no-match', via: 'anchorVerifier' }],
    'the ONLY rejection is the paraphrase, and it is rejected as no-match (not as "the engine could not even look")',
  )
  assert.ok(submitted.unanchored < submitted.findings.length + submitted.unanchored,
    'not everything was unanchored: three findings survived and were counted')
  assert.ok(!submitted.findings.some((finding) => finding.id === 'f-paraphrase'), 'an unanchored finding is not an effective finding')
  assert.equal(submitted.criticismKind, 'triage')
  assert.match(submitted.summary, /不完整/u)
  assert.match(submitted.summary, /recall-first/u)

  // SHAPE CONTROL (t22): the same four findings, submitted in the OLD shape
  // (domain key at the top level, no `documents`), measure reviewed 0 with all
  // four rejected as `no-documents`. This is the state the old `<= 3` bound was
  // hiding, pinned so it cannot come back unnoticed — and it is what makes the
  // `reviewed === 3` above non-vacuous: the number tracks the submission shape.
  const controlSubmitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'risk-compliance',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    findings: [
      ...anchoredFindings.map(({ locator, ...rest }) => ({ ...rest, clauseId: locator.clauseId })),
      { id: 'f-paraphrase', path: paraphraseFinding.path, clauseId: paraphraseFinding.locator.clauseId, severity: 'high', message: '转述而非抄写', evidence: paraphraseFinding.evidence },
    ],
  }, {})
  assert.equal(controlSubmitted.coverage.reviewed, 0,
    'domain key outside `locator` + no `documents` => nothing can anchor (this is the old shape)')
  assert.equal(controlSubmitted.unanchored, 4)
  assert.deepEqual([...new Set(controlSubmitted.unanchoredDetails.map((item) => item.tier))], ['no-documents'],
    'every rejection is "the engine was given nothing to recompute against", not a real verdict')
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'risk-compliance' }, {})
  const listed = await ctx.__tools.get('adjudicate_risk_compliance_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'risk-compliance' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    const name = evidenceToolName('risk-compliance', tool.name)
    assert.ok(ctx.__tools.has(name), `${name} must be registered on activation`)
  }
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'risk-compliance' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('risk-compliance', tool.name)), false)
  }
})

await testAsync('the registered evidence tool is bounded end to end through the plugin', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'risk-compliance' }, {})
  const tool = ctx.__tools.get(evidenceToolName('risk-compliance', 'read_surface'))
  const big = { path: 'service/big.ts', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 'service/big.ts', documents: [big] }, {})
  assert.equal(result.truncated, true)
  assert.ok(result.items.length <= 120)
  assert.equal(result.domain, 'risk-compliance')
  assert.match(result.summary, /截断/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'risk-compliance',
    target: 'replacement probe',
    candidates: [
      { path: 'dp-01/service/a.ts' },
      { path: 'dp-01/service/b.ts' },
      { path: 'rt-02/data/c.ts' },
      { path: 'rt-02/data/d.ts' },
    ],
  }, {})
  // v1 declared the string 'regulation'; v2 declares the object form with
  // `resolve`. The object form always applies — that is the migration.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'clause')
  assert.equal(plan.bundleKey.derived, 4)
  assert.equal(plan.bundles.length, 2)
  const dp = plan.bundles.find((item) => item.key === 'dp-01')
  assert.ok(dp !== undefined, 'the two candidates of one clause must share one bundle')
  assert.deepEqual(dp.paths.sort(), ['dp-01/service/a.ts', 'dp-01/service/b.ts'])
  assert.equal(resolveBundleKey(pack, { path: 'dp-01/service/a.ts' }, {}).key, 'dp-01')
  assert.equal(
    resolveBundleKey(pack, { path: 'dp-01/service/a.ts' }, {}).key,
    resolveBundleKey(pack, { path: 'dp-01/service/b.ts' }, {}).key,
    'two candidates of the same clause must resolve to the SAME bundle key',
  )
  assert.notEqual(
    resolveBundleKey(pack, { path: 'dp-01/service/a.ts' }, {}).key,
    resolveBundleKey(pack, { path: 'rt-02/data/c.ts' }, {}).key,
    'and two different clauses must NOT collide',
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
