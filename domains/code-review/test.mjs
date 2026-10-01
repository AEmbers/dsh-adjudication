/**
 * code-review — domain end-to-end test (contract v2, `test.mjs`).
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
 * Then it drives the assembled pack through the plugin's own mock Cordis
 * context, so the domain is proven to work where it is actually used and not
 * merely in isolation.
 *
 * TWO THINGS THIS FILE REFUSES TO DO
 * ----------------------------------
 * 1. It never asserts a status without asserting the tier. "anchored" alone is
 *    satisfiable by a verifier that guesses; the tier is what says it did not.
 * 2. It never lets P4 and P6 share a prompt. `assert.notEqual(p6.system,
 *    p4.system)` is load-bearing: the contract validators do NOT check it, so
 *    without this assertion a domain could pass `validateDomainPackV2` while
 *    handing its reviewer its own reasoning back.
 *
 * Usage: `node domains/code-review/test.mjs`
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
  defineDomainPackV2,
  evidenceToolName,
  inputFormatFor,
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
  DEFAULT_SECRET_PATTERNS,
  bundle,
  coverage,
  createBudget,
  gate,
  report,
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { loadDomain, loadDomains, discoverDomains, createNodeIo } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack from './index.js'
import source, { parseUnifiedDiff } from './source.js'
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

/**
 * Enumerate + gate one fixture.
 *
 * A fixture may NARROW the pack's gate (`fixture.gate.exclude`); it can never
 * widen it. Widening would let a fixture quietly re-admit a category the pack
 * exists to exclude, which is the opposite of what a boundary fixture is for.
 *
 * ADDED (t36): that narrowing mechanism is for exercising the MECHANISM. It must
 * never be what makes a boundary hold — see `runP1PackOnly` below, which is what
 * the all-gated-out boundary uses.
 */
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

/**
 * Enumerate + gate one fixture with the PACK's gate and nothing else.
 *
 * ADDED (t36). This is the gate that exists in production: through the real plan
 * tool the fixture is not consulted at all. A boundary proven with any other gate
 * is a statement about the test harness, not about the pack.
 */
// ...which is exactly how the generated-code pattern came to be "excluded" while
// the real tool admitted `generated/types.ts`. See `docs/review-antipatterns.md` §1.4.
function runP1PackOnly(name) {
  const { input } = inputPayload(name)
  const context = { maxCandidates: 400, maxExcerptLines: 500 }
  const enumerated = source.enumerate(input.payload, context)
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

console.log('\ncode-review domain — contract v2 end-to-end')
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
  // `validateDomainPackV2` cannot see a bare index.js (the extension points and
  // the fixture list are assembled by the loader), so the pack's own half is
  // checked here and the whole-pack gate is checked after `loadDomain` below.
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
  const declared = inputFormatFor('code-review')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
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

// ---------------------------------------------------------------------------
// P3 — rules
// ---------------------------------------------------------------------------

console.log('\nP3 — the rule library')

const ruleFiles = RULE_FILES

test(`rules/ ships at least ${MIN_RULES_PER_DOMAIN} documents`, () => {
  assert.ok(ruleFiles.length >= MIN_RULES_PER_DOMAIN, `found ${ruleFiles.length}`)
})

test('every rule document is valid: name / match / text / needs-expert-review', () => {
  const problems = []
  for (const file of ruleFiles) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    problems.push(...validateRuleDocument(text, file))
    assert.match(text, /needs-expert-review: true/u, `${file} must state its provenance in front-matter`)
  }
  assert.deepEqual(problems, [], problems.join('; '))
})

test('no rule document claims expert validation', () => {
  for (const file of ruleFiles) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    assert.doesNotMatch(text, /expert-validated|已通过专家|专家审定/u, `${file} must not claim expert validation`)
  }
})

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'go-only', match: ['**/*.go'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['src/app.ts'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  // The two extra fixtures this domain ships are the ones its own structure
  // needs: a multi-file change (bundling) and a small one (short circuit).
  assert.ok(FIXTURES.has('small-change'))
  assert.ok(FIXTURES.has('happy-path'))
})

test('every fixture declares anchors with both positive and negative cases', () => {
  for (const [name, value] of FIXTURES) {
    assert.ok(value.anchors, `${name} must declare anchors`)
    assert.ok(value.anchors.positive?.length > 0, `${name} needs a positive anchor case`)
    assert.ok(value.anchors.negative?.length > 0, `${name} needs a negative anchor case`)
  }
})

// ---------------------------------------------------------------------------
// P0 / P1 — the three boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — empty / all-gated-out / admitted')

test('boundary: empty diff produces an EMPTY candidate set, and an empty gate', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  assert.equal(enumerated.candidates.length, fixture('empty').expect.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path), fixture('empty').expect.paths)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
})

test('boundary: the PACK\'s own gate removes EVERY candidate in all-gated-out', () => {
  const value = fixture('all-gated-out')
  const expected = value.expect

  // CHANGED (t36). This is the reference-domain boundary that eighteen other
  // domains were written from, and it used to be proven with
  // `[...pack.gate.exclude, ...fixture.gate.exclude]` while the fixture carried
  // `{exclude: ['**/generated/**']}`. That made the claim circular, and the real
  // plan tool admitted exactly one candidate — `generated/types.ts`, the pattern
  // the fixture was quietly supplying. See `docs/review-antipatterns.md` §1.4.
  //
  // So the fixture no longer carries a gate at all, and the gate below is built
  // from the pack ONLY. The first assertion is what keeps it that way.
  assert.equal(value.gate, undefined, 'the fixture must not be doing the work its own boundary claims')

  const { enumerated, result } = runP1PackOnly('all-gated-out')

  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path).sort(), [...expected.paths].sort())
  assert.equal(result.selected.length, expected.admitted, 'the PACK alone must admit nothing here')
  assert.equal(result.excluded.length, expected.candidates)

  // Per-predicate, not "something was excluded": a change in WHICH rule fires must
  // be visible rather than silent. `user-exclude` is the bucket the pack's own
  // list fills, so asserting it carries `generated/types.ts` is the part that
  // distinguishes this from the old, fixture-assisted proof.
  const predicates = byPredicate(result)
  // `excludedByPredicate` declares one entry per predicate the fixture means to
  // exercise. A predicate the corpus never triggers is still declared, as an empty
  // list (`too-large`), and an empty list cannot appear in a report assembled from
  // actual exclusions — comparing key sets directly would be comparing a subset
  // against a superset.
  const claimed = Object.fromEntries(Object.entries(expected.excludedByPredicate)
    .filter(([, paths]) => paths.length > 0))
  assert.deepEqual(Object.keys(predicates).sort(), Object.keys(claimed).sort(),
    'the predicate categories must be exactly the ones the boundary claims')
  for (const [predicate, paths] of Object.entries(claimed)) {
    assert.deepEqual(predicates[predicate] ?? [], [...paths].sort(), `predicate "${predicate}" mismatch`)
  }
  assert.deepEqual(predicates['user-exclude'], ['generated/types.ts'],
    'the generated file must be excluded by the PACK\'s own rule, not by an engine default')
  assert.deepEqual(predicates['default-path'], ['node_modules/leftpad/index.js'],
    'and the engine defaults must still be doing their own part')
})

test('no fixture supplies exclude rules of its own — exclusions must come from the pack', () => {
  // The property behind the test above, asserted across the whole directory so a
  // future fixture cannot reintroduce the circularity one file at a time.
  const offenders = [...FIXTURES]
    .filter(([, value]) => value.gate !== undefined && (value.gate.exclude ?? []).length > 0)
    .map(([name]) => name)
  assert.deepEqual(offenders, [], 'no fixture may declare exclude rules — the rule belongs in the pack')
  for (const [name, value] of FIXTURES) {
    assert.equal(Object.hasOwn(value, 'exclude'), false, `${name} must not carry a top-level exclude`)
  }
})

test('the pack\'s own rule — not an engine default — is what excludes the generated file', () => {
  // SHAPE CONTROL (t36). `user-exclude` is the bucket for the pack's whole exclude
  // list, so the bucket name alone cannot say WHICH pattern did it. Remove the one
  // pattern and check the candidate comes back: that is the only thing here that
  // proves the pack's rule is load-bearing rather than incidentally redundant.
  const { enumerated, result } = runP1PackOnly('all-gated-out')
  const generated = result.excluded.find((item) => item.path === 'generated/types.ts')
  assert.ok(generated !== undefined, 'the generated file must be excluded')
  assert.equal(generated.predicate, 'user-exclude',
    'the engine\'s defaults do not cover `generated/` — this bucket is the pack\'s own list')

  const control = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: pack.gate.exclude.filter((pattern) => pattern !== '**/generated/**'),
    extensions: pack.gate?.extensions ?? null,
  })
  assert.deepEqual(control.selected.map((item) => item.path), ['generated/types.ts'],
    'control: with the pack\'s own rule removed this file IS admitted — so the rule is what excludes it')
  assert.equal(control.selected.length, 1, 'and it is the ONLY such file: one pattern, one candidate')
})

test('boundary: an empty set and a fully-excluded set are distinguishable in the plan', () => {
  const empty = runP0P1('empty')
  const gatedOut = runP0P1('all-gated-out')
  assert.equal(empty.enumerated.candidates.length, 0, 'empty: P0 produced nothing')
  assert.equal(empty.result.excluded.length, 0)
  assert.ok(gatedOut.enumerated.candidates.length > 0, 'all-gated-out: P0 produced something')
  assert.ok(gatedOut.result.excluded.length > 0, 'all-gated-out: P1 removed it')
})

test('happy path: the multi-file diff is admitted whole and bundles into more than one group', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
})

test('small change: one file, one hunk, admitted', () => {
  const expected = fixture('small-change').expect
  const { enumerated, result } = runP0P1('small-change')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
})

test('the gate is the engine\'s ordered predicate list, and the pack only narrows it', () => {
  assert.deepEqual(gate([], {}).ordered, DEFAULT_GATE_PREDICATES.map(([label]) => label))

  // CHANGED (t36). This used to pin the pack's exclude list to an exact three
  // entries and to allow a pattern only if it restated an engine default. That is
  // the "too tight" shape: it can only be green while the list looks exactly as it
  // did, so a CORRECT fix turns it red, and the red says nothing about behaviour.
  //
  // The property asserted instead: a restatement is allowed (it changes only the
  // reason text a report shows), while a rule the pack INVENTs must be one whose
  // removal actually changes what the real boundary admits — invented-but-
  // decorative rules are what this replaced, and they are still rejected here.
  const restated = pack.gate.exclude.filter((pattern) => DEFAULT_EXCLUDE_PATTERNS.includes(pattern))
  const invented = pack.gate.exclude.filter((pattern) => !DEFAULT_EXCLUDE_PATTERNS.includes(pattern))
  assert.ok(restated.length > 0,
    'the restatements are still declared — they are what makes the reason text name this domain\'s rules')
  assert.ok(invented.some((pattern) => pattern.includes('generated')),
    'the pack must exclude generated code ITSELF: the all-gated-out boundary depends on the pack, not on a fixture')

  // Every invented rule must be load-bearing against the corpus its own boundary
  // uses. `user-exclude` is one bucket for the whole list, so the bucket name alone
  // cannot say which pattern fired; removing one pattern at a time can.
  const { enumerated } = runP1PackOnly('all-gated-out')
  const withAll = gate(enumerated.candidates, { exclude: pack.gate.exclude, extensions: pack.gate.extensions })
  for (const pattern of invented) {
    const without = gate(enumerated.candidates, {
      exclude: pack.gate.exclude.filter((entry) => entry !== pattern),
      extensions: pack.gate.extensions,
    })
    assert.ok(without.selected.length > withAll.selected.length,
      `"${pattern}" is the pack's own rule but excludes nothing the all-gated-out boundary exercises — justify it or drop it`)
  }

  assert.ok(!pack.gate.exclude.includes('**/node_modules/**'), 'node_modules is covered by default-path')
  assert.ok(!pack.gate.exclude.includes('**/vendor/**'), 'vendor is covered by default-path')
})

test('a candidate larger than the ceiling is removed by the too-large predicate', () => {
  const result = gate([{ path: 'src/huge.ts', bytes: 4096 }], { extensions: pack.gate.extensions, maxFileBytes: 1024 })
  assert.deepEqual(result.selected, [])
  assert.equal(result.excluded[0].predicate, 'too-large')
})

test('P0 declares bounded:true and the contract agrees for this domain', () => {
  assert.equal(source.bounded, true)
  assert.equal(inputFormatFor('code-review').bounded, true)
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ diff: 42 }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ diff: '', files: 'nope' }, {}), /E_INPUT_FORMAT/u)
  // A missing `diff` is NOT the same as an empty diff: one is a malformed
  // request, the other is a legitimate "nothing changed".
  assert.doesNotThrow(() => source.enumerate({ diff: '' }, {}))
})

test('candidate ids are unique and `path` stays a gate-globable file path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'a synthetic id must never leak into candidate.path')
    assert.equal(typeof candidate.locator.startLine, 'number', `${candidate.id} needs a locator startLine`)
    assert.equal(typeof candidate.locator.hunkIndex, 'number', `${candidate.id} needs a locator hunkIndex`)
  }
})

test('the source reports excluded items and notes rather than dropping them', () => {
  const enumerated = source.enumerate({ diff: 'diff --git a/x b/x\nold mode 100644\nnew mode 100755\n' }, {})
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(enumerated.excluded.length, 1)
  assert.match(enumerated.excluded[0].reason, /no hunks/u)
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling')

test('the single-file change short-circuits to one bundle', () => {
  const { result } = runP0P1('small-change')
  const keyed = result.selected.map((entry) => {
    const parts = entry.path.split('/')
    parts.pop()
    return { ...entry, key: parts.length === 0 ? '.' : parts[0] }
  })
  const bundled = bundle(keyed)
  assert.equal(bundled.bundles.length, 1)
  assert.equal(bundled.strategy, 'short-circuit-single')
})

test('the multi-file change really splits into more than one bundle key', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => {
    const parts = entry.path.split('/')
    parts.pop()
    return { ...entry, key: parts[0] }
  })
  const bundled = bundle(keyed)
  const keys = bundled.bundles.map((item) => item.key).sort()
  assert.deepEqual(keys, fixture('happy-path').expect.bundleKeys)
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
      if (entry.expectStart !== undefined) assert.equal(verdict.start, entry.expectStart)
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
    })
  }
  for (const entry of value.anchors.ambiguous ?? []) {
    test(`anchor ambiguous [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, 'unanchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.ok(Array.isArray(verdict.ambiguousIn) && verdict.ambiguousIn.length > 1,
        'an ambiguous verdict must list the competing locations')
      // The fixture may pin the exact competing locations; if it does, it must
      // be the thing asserted — otherwise the field is decoration.
      if (entry.expectAmbiguousIn !== undefined) {
        assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
      }
      assert.equal(typeof verdict.detail, 'string', 'every unanchored verdict must explain itself')
    })
  }
}

test('a paraphrase never anchors, even when the intent is obvious', () => {
  const documents = [{ path: 'src/a.ts', content: 'const total = sum(items)\n' }]
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'src/a.ts', locator: {}, excerpt: 'const total = add(items)' },
    { path: 'src/a.ts', documents },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a wrong line number is refused rather than repaired', () => {
  const documents = [{ path: 'src/a.ts', content: 'const a = 1\nconst b = 2\n' }]
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'src/a.ts', locator: { startLine: 99 }, excerpt: 'const b = 2' },
    { path: 'src/a.ts', documents },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a declared window running past the end of the file is refused, not clamped', () => {
  const documents = [{ path: 'src/a.ts', content: 'only one line\n' }]
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'src/a.ts', locator: { startLine: 1 }, excerpt: 'only one line\nand a second' },
    { path: 'src/a.ts', documents },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a document set without the named path relocates only when unique', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'src/nowhere.ts', locator: {}, excerpt: 'unique line' },
    { path: 'src/nowhere.ts', documents: [{ path: 'src/here.ts', content: 'x\nunique line\ny\n' }] },
  )
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'relocated-unique')
  assert.equal(verdict.start, 2)
  assert.equal(verdict.end, 2)
})

test('indentation and diff markers are tolerated; nothing else is', () => {
  const documents = [{ path: 'src/a.ts', content: 'function f() {\n    return 1\n}\n' }]
  const tolerated = anchor.verify(
    { kind: 'diff-line', path: 'src/a.ts', locator: {}, excerpt: '+\treturn  1' },
    { path: 'src/a.ts', documents },
  )
  assert.equal(tolerated.status, 'anchored')
  assert.equal(tolerated.start, 2)

  const punctuation = anchor.verify(
    { kind: 'diff-line', path: 'src/a.ts', locator: {}, excerpt: 'return 1;' },
    { path: 'src/a.ts', documents },
  )
  assert.equal(punctuation.status, 'unanchored', 'a changed semicolon is a changed line')
})

test('KNOWN BOUNDARY: a line whose own text starts with a diff marker is matched only when the marker counts agree', () => {
  // `normalizeLine` strips `/^[+-]/` — a POSITION-0 match — on BOTH sides. So a
  // line whose content itself begins with `-`/`+` (CSS custom property `--x`,
  // YAML sequence `- x`, Markdown bullet, leading arithmetic) has its comparison
  // form decided by whether a marker sits at column 0, which the document line
  // and the quoted excerpt need not agree on.
  //
  // The tolerance documented in lib/contracts.js ("diff markers may be ignored")
  // therefore holds in ONE DIRECTION ONLY for such lines: quoting WITH the diff
  // marker can match, quoting verbatim WITHOUT it cannot. Three ordinary
  // spellings of an ordinary line all still anchor.
  //
  // This is a RECALL loss, never a precision loss: a paraphrase still never
  // anchors. It is a decision, not an oversight — deliberately NOT fixed —
  // because (1) it reproduces the upstream rule this reference domain exists to
  // stay comparable with, (2) `normalizeLine` has 13 independent copies across
  // 12 domains and no domain imports the engine's, so "fixing" it means editing
  // 13 files spanning 5 owners' scopes, and (3) the ladder trades recall for
  // precision by design. Recorded, with the structural debt, in
  // docs/domain-contract-v2.md §1.2, "已知边界" — change it there first.
  const css = 'a {\n  --focus-ring: 0 0 0 2px var(--accent);\n  color: red;\n}\n'

  const noMarker = anchor.verify(
    { kind: 'diff-line', path: 'src/a.css', locator: {}, excerpt: '--focus-ring: 0 0 0 2px var(--accent);' },
    { path: 'src/a.css', content: css },
  )
  assert.equal(noMarker.status, 'unanchored', 'verbatim quote of a `--`-leading line does not anchor')
  assert.equal(noMarker.tier, 'no-match')

  const withMarker = anchor.verify(
    { kind: 'diff-line', path: 'src/a.css', locator: {}, excerpt: '+--focus-ring: 0 0 0 2px var(--accent);' },
    { path: 'src/a.css', content: css },
  )
  assert.equal(withMarker.status, 'anchored', 'the same line DOES anchor when the diff marker is quoted')
  assert.equal(withMarker.start, 2)

  // The ordinary-line control: all three spellings normalise identically.
  for (const excerpt of ['color: red;', '  color: red;', '+\tcolor:  red;']) {
    const ordinary = anchor.verify(
      { kind: 'diff-line', path: 'src/a.css', locator: {}, excerpt },
      { path: 'src/a.css', content: css },
    )
    assert.equal(ordinary.status, 'anchored', `ordinary line must anchor for excerpt ${JSON.stringify(excerpt)}`)
    assert.equal(ordinary.start, 3)
  }

  // Precision is untouched by the boundary: the paraphrase of the SAME line is
  // still refused, so this can never be read as "sloppy matching is allowed".
  const paraphrase = anchor.verify(
    { kind: 'diff-line', path: 'src/a.css', locator: {}, excerpt: '+--focus-ring: 0 0 0 2px var(--accent); /* tuned */' },
    { path: 'src/a.css', content: css },
  )
  assert.equal(paraphrase.status, 'unanchored')
  assert.equal(paraphrase.tier, 'no-match')
})

test('a cross-file relocation must be unique', () => {
  const documents = [
    { path: 'src/one.ts', content: 'const shared = 1\n' },
    { path: 'src/two.ts', content: 'const shared = 1\n' },
  ]
  const ambiguous = anchor.verify(
    { kind: 'diff-line', path: 'src/missing.ts', locator: {}, excerpt: 'const shared = 1' },
    { path: 'src/missing.ts', documents },
  )
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['src/one.ts:1', 'src/two.ts:1'])

  const unique = anchor.verify(
    { kind: 'diff-line', path: 'src/missing.ts', locator: {}, excerpt: 'const shared = 1' },
    { path: 'src/missing.ts', documents: [documents[0]] },
  )
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
  assert.equal(unique.path, 'src/one.ts')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'clause-and-evidence', path: 'src/a.ts', locator: {}, excerpt: 'x' },
    { path: 'src/a.ts', content: 'x\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'diff-line' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'diff-line', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(
    () => anchor.verify({ kind: 'diff-line', path: 'a', locator: { side: 'both' }, excerpt: 'x' }, {}),
    /E_ANCHOR_CONTRACT/u,
  )
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['src/app.ts'],
  bundle: { key: 'src', paths: ['src/app.ts'], rules: ['error-handling'] },
  ruleText: '<rules path="src/app.ts">\n错误处理：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', path: 'src/app.ts', evidence: 'const total = sum(items)', message: 'sum() 未处理空输入', defended: true },
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
  assert.doesNotMatch(P6.system, /本轮负责的路径/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /错误处理/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /错误处理/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts repeat the anchor law: quote the text, never the line number', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /行号/u)
  }
  assert.match(P4.system, /不要输出行号|永远不要输出行号/u)
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

const DOCS = [
  { path: 'src/a.ts', content: 'line1\nline2\nneedle here\nline4\n' },
  { path: 'src/b.ts', content: 'needle also here\n' },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('read_lines returns at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('read_lines')
  const big = { path: 'src/big.ts', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 'src/big.ts', start: 1, documents: [big] }, {})
  assert.ok(result.items.length <= tool.limits.maxLines, `${result.items.length} > ${tool.limits.maxLines}`)
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.equal(typeof result.provenance, 'string')
  assert.ok(result.provenance.length > 0)
})

await testAsync('read_lines does not truncate when the request fits', async () => {
  const tool = toolByName('read_lines')
  const result = await tool.execute({ path: 'src/a.ts', start: 2, end: 3, documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => item.line), [2, 3])
  assert.equal(result.truncated, false)
})

await testAsync('search_diff caps its hit count and reports the cap', async () => {
  const tool = toolByName('search_diff')
  const many = { path: 'src/many.ts', content: Array.from({ length: 500 }, () => 'needle').join('\n') }
  const result = await tool.execute({ pattern: 'needle', documents: [many] }, {})
  assert.ok(result.items.length <= tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('search_diff reports the provenance of what it scanned', async () => {
  const tool = toolByName('search_diff')
  const result = await tool.execute({ pattern: 'needle', documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => `${item.path}:${item.line}`), ['src/a.ts:3', 'src/b.ts:1'])
  assert.equal(result.truncated, false)
  assert.match(result.provenance, /2 个文件/u)
})

await testAsync('enclosing walks up by indentation and is honest that it is a heuristic', async () => {
  const tool = toolByName('enclosing')
  const document = { path: 'src/f.ts', content: 'function f() {\n  if (x) {\n    return 1;\n  }\n}\n' }
  const result = await tool.execute({ path: 'src/f.ts', line: 3, documents: [document] }, {})
  assert.equal(result.items[0].line, 2)
  assert.match(result.provenance, /启发式/u)
})

await testAsync('a request naming an absent document fails loudly with the available paths', async () => {
  const tool = toolByName('read_lines')
  // The tool throws synchronously: the contract's failure mode is a throw, and
  // `assert.throws` is the assertion that proves it. `assert.rejects` would
  // pass for a tool that merely returned a rejected promise.
  assert.throws(() => tool.execute({ path: 'src/nope.ts', documents: DOCS }, {}),
    /文档集里没有 "src\/nope\.ts"/u)
})

await testAsync('a request with no documents at all is refused, not answered with "nothing found"', async () => {
  const tool = toolByName('read_lines')
  assert.throws(() => tool.execute({ path: 'src/a.ts' }, {}), /缺少 `documents`/u)
})

await testAsync('a request that exceeds the declared bound is still returned truncated, never silently', async () => {
  const tool = toolByName('search_diff')
  const many = { path: 'src/many.ts', content: Array.from({ length: 500 }, () => 'needle').join('\n') }
  const result = await tool.execute({ pattern: 'needle', documents: [many] }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('code-review', 'read_lines'), 'adjudicate_code_review_evidence_read_lines')
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
                path: 'src/app.ts',
                evidence: 'const total = sum(items)',
                message: 'sum() 未处理空输入',
                severity: 'high',
                defended: true,
              }],
            },
          }),
          dispose: async () => {},
        }
      },
    },
  }, { maxRounds: 2, maxFindings: 10 })

  const { result } = runP0P1('happy-path')
  const bundled = bundle(result.selected.map((entry) => ({ ...entry, key: entry.path.split('/')[0] })))
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
  assert.match(requests[0].prompt[0].text, /代码评审/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /不要输出行号/u, 'the anchor law must survive into the child prompt')
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
    { id: 'proven', path: 'src/a.ts', start: 1, severity: 'high', evidence: 'x', defended: true },
    { id: 'bare', path: 'src/a.ts', start: 2, severity: 'low', evidence: '' },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['proven'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['bare'])
  assert.equal(panel.kind, 'fact-checker')
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  const findings = [
    { id: 'a1', path: 'src/a.ts', start: 1, severity: 'high', evidence: 'x', defended: true },
    { id: 'a2', path: 'src/b.ts', severity: 'high', evidence: 'y', defended: true },
  ]
  const anchored = findings.filter((finding) => typeof finding.start === 'number' && finding.start > 0)
  assert.equal(anchored.length, 1)
  const proof = coverage(2, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.5, 'the unanchored path must not be counted as reviewed')
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 'src/a.ts', start: 1, severity: 'high', evidence: 'x', defended: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 5, excluded: 0, bundles: 2 },
    findings: panel.kept,
    coverageProof: coverage(5, panel.kept),
    budget: { toolCalls: 1, tokens: 10, note: 'estimate only' },
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'code-review')
  assert.equal(built.lossOrientation, 'precision-first')
  assert.equal(built.criticismKind, 'fact-checker')
  assert.equal(built.coverage.total, 5)
  assert.equal(built.coverage.reviewed, 1)
  assert.equal(built.coverage.coverageRate, 0.2)
  assert.equal(built.generatedAt, null, 'a deterministic engine must not stamp wall-clock time')
})

// ---------------------------------------------------------------------------
// The domain as loaded from disk
// ---------------------------------------------------------------------------

console.log('\nloader — the directory form is what the plugin actually sees')

/**
 * An io rooted at the PACKAGE (one level above `domains/`), so paths are
 * `domains/code-review/...` exactly as the loader expects them. This is the
 * same construction `index.js` uses for its lazy discovery.
 */
const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

/**
 * CHANGED (t17): every domain directory that actually exists on disk, derived
 * from the LIVE directory listing using the loader's own discovery rule
 * (directory + kebab-case id + a sibling index.js).
 *
 * WHY THIS EXISTS: three assertions in this file used to hard-code
 * `['code-review']` as the discovered-pack list, and one hard-coded
 * `replaced === ['code-review']`. That asserts "how many domains exist TODAY",
 * not "what the rule is". It was true only because this file was written when
 * code-review was the only directory under `domains/`; the moment a second
 * domain owner created `domains/<id>/`, every one of them went red for a reason
 * that had nothing to do with their work.
 *
 * The rule the loader promises is: *every* qualifying directory is discovered,
 * *none* is silently skipped, and each loaded pack is accounted for exactly
 * once. That rule is domain-count independent — and strictly stronger than the
 * old assertion, which only ever proved "exactly one".
 */
const DOMAIN_DIRECTORY_IDS = readdirSync(join(here, '..'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/u.test(entry.name))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(here, '..', name, 'index.js')))
  .sort()

/**
 * CHANGED (t17): the accounting invariant that replaces "code-review is the only
 * domain in the package".
 *
 * Every qualifying directory must end up EITHER loaded OR explicitly skipped
 * with a reason. Nothing may vanish, and nothing may be counted twice. That is
 * the rule the loader actually promises, it is domain-count independent, and it
 * is stronger than the old assertions: the old ones only ever proved "exactly
 * one domain exists", which is a statement about the calendar, not the code.
 *
 * Note `loaded ∪ skipped == directories` rather than `packs == directories`: a
 * sibling that is mid-flight (a directory exists but its pack does not yet pass
 * `validateDomainPackV2`) is *correctly* skipped with a readable reason. That is
 * the loader working, not a domain going missing — so the test allows it, while
 * still refusing to let any directory disappear without a trace.
 */
function assertEveryDirectoryAccountedFor(result, extraIds = []) {
  const loaded = result.packs.map((item) => item.id)
  const skipped = result.skipped.map((entry) => entry.id)
  const accounted = new Set([...loaded, ...skipped])
  for (const id of [...DOMAIN_DIRECTORY_IDS, ...extraIds]) {
    assert.equal(
      accounted.has(id),
      true,
      `domain directory "${id}" vanished: it is neither loaded nor skipped`,
    )
  }
  assert.equal(
    accounted.size,
    loaded.length + skipped.length,
    'no directory may be counted twice',
  )
  for (const entry of result.skipped) {
    assert.equal(
      typeof entry.reason === 'string' && entry.reason !== '',
      true,
      `skipped directory "${entry.id}" must carry a reason — silent skipping is the failure mode this guards`,
    )
  }
}

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: 'code-review', dir: 'domains/code-review' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'diff-hunks')
  assert.equal(assembled.anchorVerifier.kind, 'diff-line')
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
  // CHANGED (t17): discovery is asserted against the LIVE directory listing.
  // The old form was `assert.deepEqual(result.packs.map(i => i.id), ['code-review'])`,
  // which hard-coded how many domains existed on the day it was written and went
  // red the moment a second domain owner created their directory.
  const discovery = discoverDomains(io, { root: 'domains' })
  assert.deepEqual(
    discovery.found.map((entry) => entry.id).sort(),
    DOMAIN_DIRECTORY_IDS,
    'discovery must find exactly the qualifying directories that exist',
  )
  // Scan-level skips are allowed — a sibling directory that has no index.js yet,
  // or a shared `_lib` helper, is legitimately not a domain. What is NOT allowed
  // is a qualifying directory disappearing without a reason, or being skipped
  // despite qualifying.
  const foundIds = new Set(discovery.found.map((entry) => entry.id))
  for (const entry of discovery.skipped) {
    assert.equal(typeof entry.reason === 'string' && entry.reason !== '', true, `scan-level skip "${entry.id}" must carry a reason`)
    assert.equal(foundIds.has(entry.id), false, `"${entry.id}" cannot be both found and skipped`)
  }

  const result = await loadDomains(io, { root: 'domains' })
  // CHANGED (t17): `problems` is package-wide, so a sibling that is mid-flight
  // would fail this file. What this file may assert is that THIS domain produces
  // no problems — which is the claim that was always meant.
  assert.deepEqual(
    result.problems.filter((entry) => entry.id === 'code-review'),
    [],
    JSON.stringify(result.problems),
  )
  assertEveryDirectoryAccountedFor(result)
  assert.equal(result.packs.some((item) => item.id === 'code-review'), true, 'this domain must load')
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
  // CHANGED (t17): was `assert.deepEqual(result.packs.map(i => i.id), ['code-review'])`.
  // Same calendar-coupled claim; the rule under test is "the broken sibling is
  // rejected while every VALID domain still loads, and nothing vanishes".
  assertEveryDirectoryAccountedFor(result, ['bad-domain'])
  assert.equal(result.packs.some((item) => item.id === 'bad-domain'), false, 'the broken sibling must not load')
  const broken = result.skipped.filter((entry) => entry.id === 'bad-domain')
  assert.equal(broken.length, 1, 'the broken sibling must be skipped exactly once')
  assert.match(broken[0].reason, /invalid v2 pack/u)
  // Domain-package level skips key on `id` (unified by t16 across BOTH levels).
  assert.equal(result.skipped.every((entry) => typeof entry.id === 'string'), true, 'every skip names an id')
  // CHANGED (t17): was `assert.match(result.skipped[0].reason, /invalid v2 pack/u)`,
  // which quietly assumed the injected sibling would be the FIRST entry in the
  // skip list — i.e. that no other directory had appeared yet. The rule being
  // tested is "the injected sibling is skipped for being invalid", which is now
  // asserted above by id; the residual claim worth keeping is that no directory
  // is ever skipped anonymously.
  assert.equal(
    result.skipped.every((entry) => typeof entry.reason === 'string' && entry.reason !== ''),
    true,
    'no directory may be skipped without a reason',
  )
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
  // No `domains` subset: the replacement semantics being tested are about the
  // full built-in library, and a subset would hide a count regression.
  applyPlugin(ctx, { promptSection: false })
  return ctx
}

await testAsync('adjudication_plan consumes the fixture diff through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'code-review',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'diff-hunks')
  assert.equal(plan.candidateSet.inputFormat, 'unified-diff')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.ok(plan.bundles.length > 1, 'a multi-file change must not collapse into one bundle')
  assert.equal(plan.criticism.kind, 'fact-checker')
  assert.match(plan.summary, /复核者：fact-checker/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'code-review',
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
    domain: 'code-review',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})

  // CHANGED (t36): through the real plan tool the pack's OWN gate applies, and the
  // pack now excludes `**/generated/**` itself — so nothing survives. Before this
  // change this test asserted `admitted === 1` and `bundles[0].paths` was
  // `['generated/types.ts']`: the fixture's narrowing had been hiding a real gap
  // between the boundary claim and the production gate. See
  // `docs/review-antipatterns.md` §1.4.
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'assets/logo.png': 'binary',
    'config/.env': 'secret',
    'legacy/old.go': 'deleted',
    'generated/types.ts': 'user-exclude',
    'node_modules/leftpad/index.js': 'default-path',
    'README.md': 'extension',
  })
  assert.equal(plan.gate.admitted, 0)
  assert.deepEqual(plan.bundles, [])
  assert.match(plan.summary, /准入 0 项/u)
  assert.match(plan.summary, /排除 6 项/u)
})

/**
 * CHANGED (t17): reconstruct the POST-IMAGE of every file in a fixture diff.
 *
 * This is what an anchor is recomputed against now. Before F3 was fixed,
 * `adjudication_submit` believed whatever `anchored`/`start` the caller wrote, so
 * a domain test never needed the documents the finding was supposedly anchored
 * in. With the domain verifier actually running, the finding has to be checked
 * against real file content — and the honest content is the file after the diff,
 * at the line numbers the verdict reports.
 */
function documentsFromDiff(diff) {
  return parseUnifiedDiff(diff).files
    .filter((file) => file.hunks.length > 0 && file.binary !== true)
    .map((file) => {
      const lines = []
      for (const hunk of file.hunks) {
        let cursor = (hunk.newStart > 0 ? hunk.newStart : 1) - 1
        for (const raw of hunk.textLines) {
          if (raw.startsWith('-')) continue
          lines[cursor] = raw.slice(1)
          cursor += 1
        }
      }
      return { path: file.path, content: lines.map((line) => line ?? '').join('\n') }
    })
}

await testAsync('P0 -> P7 round trip: submit excludes the unanchored finding and reports real coverage', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'code-review',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  // Three discoveries: two anchored to distinct admitted paths, one with no
  // anchor at all. Only the two anchored ones may count.
  // CHANGED (t17): `documents` is supplied because the engine now RECOMPUTES
  // every anchor through this domain's `anchorVerifier` instead of trusting
  // `finding.anchored`/`finding.start`. The expectations below are unchanged.
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'code-review',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    documents: documentsFromDiff(happy.input.payload.diff),
    findings: [
      { id: 'f1', path: 'src/app.ts', start: 4, severity: 'high', message: 'average 未防止除零以外的空集', evidence: 'const average = total / Math.max(items.length, 1)', defended: true },
      // CHANGED (t17): f2 declared `start: 3`, which is FALSE — `} catch {` is
      // line 4 of src/util/parse.ts. The old submit accepted it because it
      // believed the caller; the domain verifier now returns `locator-mismatch`
      // and the finding would be excluded. 3 -> 4 is the truth, not a relaxation.
      { id: 'f2', path: 'src/util/parse.ts', start: 4, severity: 'medium', message: 'catch 吞掉了错误细节', evidence: '} catch {', defended: true },
      { id: 'f3', path: 'src/util/format.ts', severity: 'high', message: '没有锚点的断言', evidence: '看起来不太对' },
    ],
  }, {})

  assert.equal(submitted.unanchored, 1, 'f3 has no anchor and must be excluded')
  assert.equal(submitted.findings.length, 2)
  assert.equal(submitted.criticismKind, 'fact-checker')

  // CHANGED (t17): the anchors on the report are the ones the DOMAIN verifier
  // recomputed — the caller's `start` values never reach the result. This is the
  // observable difference F3 was about: before the fix these fields came from
  // the finding object verbatim.
  assert.equal(submitted.anchorVia, 'anchorVerifier', 'the domain verifier must be the one that ran')
  const lineOf = new Map(submitted.findings.map((finding) => [finding.path, finding.start]))
  assert.equal(lineOf.get('src/app.ts'), 4)
  assert.equal(lineOf.get('src/util/parse.ts'), 4, 'the recomputed line, not the declared one')
  assert.equal(submitted.unanchoredDetails.length, 1)
  assert.equal(submitted.unanchoredDetails[0].id, 'f3')
  assert.equal(submitted.unanchoredDetails[0].via, 'anchorVerifier')
  assert.equal(typeof submitted.unanchoredDetails[0].detail, 'string')
  assert.notEqual(submitted.unanchoredDetails[0].detail, '')

  // Coverage is a real statistic: 2 distinct paths out of 5 admitted.
  const admitted = plan.gate.admitted
  const expectedRate = Number((2 / admitted).toFixed(4))
  assert.equal(submitted.coverage.total, admitted)
  assert.equal(submitted.coverage.reviewed, 2)
  assert.equal(submitted.coverage.coverageRate, expectedRate)
  assert.equal(submitted.coverage.complete, false)
  assert.match(submitted.summary, new RegExp(`${(expectedRate * 100).toFixed(1)}%`, 'u'))
  assert.match(submitted.summary, /未锚定/u)
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  const listed = await ctx.__tools.get('adjudicate_code_review_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    const name = evidenceToolName('code-review', tool.name)
    assert.ok(ctx.__tools.has(name), `${name} must be registered on activation`)
  }
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'code-review' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('code-review', tool.name)), false)
  }
})

await testAsync('the registered evidence tool is bounded end to end through the plugin', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  const tool = ctx.__tools.get(evidenceToolName('code-review', 'read_lines'))
  const big = { path: 'src/big.ts', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 'src/big.ts', documents: [big] }, {})
  assert.equal(result.truncated, true)
  assert.ok(result.items.length <= 120)
  assert.equal(result.domain, 'code-review')
  assert.match(result.summary, /截断/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'code-review',
    target: 'replacement probe',
    candidates: [{ path: 'src/a.ts', additions: 1 }, { path: 'src/b.ts', additions: 1 }, { path: 'src/c.ts', additions: 1 }, { path: 'src/d.ts', additions: 1 }],
  }, {})
  // v1 declared the string 'directory'; v2 declares the object form. The object
  // form always applies, which is exactly what the migration is supposed to show.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundles.length, 1)
  assert.equal(plan.bundles[0].key, 'src')

  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19, 'replacement must not change the domain count')
  // CHANGED (t17): was `assert.deepEqual(listed.directory.replaced, ['code-review'])`.
  // Another calendar-coupled claim. What this test is about is that a directory
  // pack DISPLACES the built-in v1 pack of the same id, so assert exactly that,
  // plus the stronger bookkeeping rule: every directory pack that was actually
  // loaded is accounted for exactly once, as a replacement or as an addition.
  assert.ok(listed.directory.replaced.includes('code-review'), 'code-review must replace its v1 pack')
  const loadedFromDirectory = [...(listed.directory.loaded ?? [])].sort()
  const accounted = [...(listed.directory.replaced ?? []), ...(listed.directory.added ?? [])].sort()
  assert.deepEqual(accounted, loadedFromDirectory, 'every loaded directory pack is a replacement or an addition, exactly once')
  for (const entry of listed.directory.skipped ?? []) {
    assert.equal(typeof entry.reason === 'string' && entry.reason !== '', true, `skipped "${entry.id}" must carry a reason`)
  }
  for (const id of listed.directory.replaced) {
    assert.ok(listed.domains.some((domain) => domain.id === id), `replaced id "${id}" must still be registered`)
  }
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
