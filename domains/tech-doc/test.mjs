/**
 * tech-doc — domain end-to-end test (contract v2, `test.mjs`).
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
 * FOUR THINGS THIS FILE REFUSES TO DO
 * -----------------------------------
 * 1. It never asserts a status without asserting the tier. "anchored" alone is
 *    satisfiable by a verifier that guesses; the tier is what says it did not.
 * 2. It never lets P4 and P6 share a prompt. `assert.notEqual(p6.system,
 *    p4.system)` is load-bearing: the contract validators do NOT check it, so
 *    without this assertion a domain could pass `validateDomainPackV2` while
 *    handing its reviewer its own reasoning back.
 * 3. It never lets the signature check be optional. This domain's whole point is
 *    that documentation drift is recomputed from the API surface; a verifier
 *    that only slid a window over the document would answer a question about
 *    typography. So there is an assertion for "signature disagrees -> unanchored"
 *    AND one for "no surface to compare against -> unanchored", because the
 *    second is the one that silently degrades into "passed".
 * 4. It never hard-codes "tech-doc is the only domain in `domains/`".
 *
 * Usage: `node domains/tech-doc/test.mjs`
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
  evidenceToolName,
  inputFormatFor,
  validateAnchorVerdict,
  validateDomainPackV2,
  validateEvidenceToolkit,
  validatePromptOutput,
  validateRuleDocument,
} from '../../lib/contracts.js'
import {
  DEFAULT_EXCLUDE_PATTERNS,
  coverage,
  createBudget,
  gate,
  report,
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { createNodeIo, discoverDomains, loadDomain, loadDomains } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack from './index.js'
import source, { MAX_CLAIMS_PER_SECTION } from './source.js'
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
  const parsed = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
  FIXTURES.set(parsed.name, parsed)
}

const fixture = (name) => {
  const value = FIXTURES.get(name)
  assert.ok(value !== undefined, `missing fixture "${name}"`)
  return value
}

const RULE_FILES = readdirSync(join(here, 'rules')).filter((file) => file.endsWith('.md')).sort()

/**
 * Enumerate + gate one fixture.
 *
 * A fixture may NARROW the pack's gate (`fixture.gate.exclude`); it can never
 * widen it. Widening would let a fixture quietly re-admit a category the pack
 * exists to exclude, which is the opposite of what a boundary fixture is for.
 *
 * ADDED (t23): that narrowing mechanism is for exercising the MECHANISM. It must
 * never be what makes a boundary hold — see `runP1PackOnly` below, which is what
 * the all-gated-out boundary uses.
 */
function runP0P1(name) {
  const value = fixture(name)
  const context = { maxCandidates: 400, maxExcerptLines: 500 }
  const enumerated = source.enumerate(value.input.payload, context)
  const result = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: [...(pack.gate?.exclude ?? []), ...(value.gate?.exclude ?? [])],
    extensions: pack.gate?.extensions ?? null,
  })
  return { enumerated, result }
}

/**
 * Enumerate + gate one fixture with the PACK's gate and nothing else.
 *
 * ADDED (t23). This is the gate that exists in production: through the plugin,
 * the fixture is not consulted at all. A boundary proven with any other gate is
 * a statement about the test harness, not about the pack.
 */
function runP1PackOnly(name) {
  const value = fixture(name)
  const context = { maxCandidates: 400, maxExcerptLines: 500 }
  const enumerated = source.enumerate(value.input.payload, context)
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

console.log('\ntech-doc domain — contract v2 end-to-end')
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
  const problems = validateDomainPackV2({
    ...pack,
    candidateSource: source,
    anchorVerifier: anchor,
    evidenceTools: evidence,
    reviewPrompts: prompts,
    ruleLibrary: {
      dir: 'rules',
      rules: RULE_FILES.map((_file, index) => ({ name: `rule-${index}`, match: ['**/*'], text: 'y'.repeat(12), needsExpertReview: true })),
    },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('tech-doc')
  assert.equal(declared.format, 'doc-corpus-and-api-surface')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, 'section-and-signature')
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable',
    'this anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('precision-first and fact-checker agree, because one of the two would otherwise be a lie', () => {
  assert.equal(pack.lossOrientation, 'precision-first')
  assert.equal(pack.criticism.kind, 'fact-checker')
})

test('the bundleKey is an object with a resolver, not a bare string strategy', () => {
  // `validateDomainPackV2` rejects a string strategy outside BUNDLE_KEY_STRATEGIES.
  // `document` is this domain's private name, so it MUST supply `resolve`.
  assert.equal(typeof pack.bundleKey, 'object')
  assert.equal(pack.bundleKey.strategy, 'document')
  assert.equal(typeof pack.bundleKey.resolve, 'function')
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

test(`rules/ ships at least ${MIN_RULES_PER_DOMAIN} documents`, () => {
  assert.ok(RULE_FILES.length >= MIN_RULES_PER_DOMAIN, `found ${RULE_FILES.length}`)
})

test('every rule document is valid: name / match / text / needs-expert-review', () => {
  const problems = []
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    problems.push(...validateRuleDocument(text, file))
    assert.match(text, /needs-expert-review: true/u, `${file} must state its provenance in front-matter`)
    assert.match(text, /source: agent-drafted/u, `${file} must say who drafted it`)
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
    { name: 'markdown-only', match: ['**/*.md'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['docs/api.md'])
  assert.deepEqual(selected.injected.map((rule) => rule.name).sort(), ['any', 'markdown-only'])
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  assert.ok(FIXTURES.has('broken-relative-link'), 'the documented fourth fixture for this format')
})

test('every fixture declares anchors with both positive and negative cases', () => {
  for (const [name, value] of FIXTURES) {
    assert.ok(value.anchors, `${name} must declare anchors`)
    assert.ok(value.anchors.positive?.length > 0, `${name} needs a positive anchor case`)
    assert.ok(value.anchors.negative?.length > 0, `${name} needs a negative anchor case`)
  }
})

// ---------------------------------------------------------------------------
// P0 / P1 — the boundaries
// ---------------------------------------------------------------------------

console.log('\nP0/P1 — candidate source and gate')

test('P0 declares bounded:true and the contract agrees for this domain', () => {
  assert.equal(source.bounded, true)
  assert.equal(inputFormatFor('tech-doc').bounded, true)
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate([], {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ api: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ documents: [], api: {} }, {}), /E_INPUT_FORMAT/u)
  // An EMPTY corpus is NOT malformed: "nothing to review" is a legitimate answer.
  assert.doesNotThrow(() => source.enumerate({ documents: [], api: [] }, {}))
})

test('boundary 1 — the empty fixture produces zero candidates, and the gate agrees', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.equal(enumerated.candidates.length, 0)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
  assert.equal(fixture('empty').expect.candidates, 0)
})

test('boundary 2 — the PACK\'s own gate drains the all-gated-out fixture', () => {
  const value = fixture('all-gated-out')
  const expectation = value.expect

  // CHANGED (t23). This boundary used to be proven with
  // `[...pack.gate.exclude, ...fixture.gate.exclude]`, and the fixture carried
  // `{exclude: ['**/generated/**']}`. That made the claim circular: it proved
  // "pack ∪ fixture drains the fixture". A boundary has to prove what the PACK
  // alone does, because the fixture's gate does not exist in production — and
  // measured through the real plugin, the generated candidate was admitted.
  //
  // So the fixture no longer carries a gate at all, and the gate below is built
  // from the pack ONLY. The first assertion is what keeps it that way.
  assert.equal(value.gate, undefined, 'the fixture must not be doing the work its own boundary claims')

  const { enumerated, result } = runP1PackOnly('all-gated-out')
  assert.equal(enumerated.candidates.length, expectation.candidates)
  assert.ok(enumerated.candidates.length > 0, 'this fixture must NOT be empty — it is the opposite boundary')
  assert.equal(result.selected.length, 0, 'the PACK alone must exclude every candidate')
  assert.deepEqual(byPredicate(result), expectation.excludedByPredicate,
    'and the reasons must be the pack\'s own — `user-exclude` is the bucket the pack declares')
})

test('the pack\'s own rule — not an engine default — is what excludes the generated candidate', () => {
  const { enumerated, result } = runP1PackOnly('all-gated-out')
  const buckets = new Set(result.excluded.map((item) => item.predicate))
  assert.deepEqual([...buckets].sort(), ['default-path', 'user-exclude'],
    'two buckets exactly: the engine defaults, and the pack\'s own exclude list')
  const generated = result.excluded.find((item) => item.path.startsWith('generated/'))
  assert.ok(generated !== undefined, 'the generated candidate must be excluded')
  assert.equal(generated.predicate, 'user-exclude',
    'the engine\'s defaults do not cover `generated/` — this bucket is the pack\'s own list')

  // SHAPE CONTROL (t23). `user-exclude` is the bucket for the pack's whole exclude
  // list, so the bucket name alone cannot say WHICH pattern did it. Remove the one
  // pattern and check the candidate comes back: that is the only thing here that
  // proves the pack's own rule is load-bearing rather than incidentally redundant.
  const control = gate(enumerated.candidates, {
    include: pack.gate?.include,
    exclude: pack.gate.exclude.filter((pattern) => pattern !== '**/generated/**'),
    extensions: pack.gate?.extensions ?? null,
  })
  assert.deepEqual(control.selected.map((item) => item.path), [generated.path],
    'control: with the pack\'s own rule removed this candidate IS admitted — so the rule is what excludes it')
})

test('boundary 3 — the happy path admits what it claims to admit', () => {
  const { enumerated, result } = runP0P1('happy-path')
  const expectation = fixture('happy-path').expect
  assert.equal(enumerated.candidates.length, expectation.candidates)
  assert.equal(result.selected.length, expectation.admitted)
  assert.deepEqual(result.selected.map((entry) => entry.path).sort(), [...expectation.paths].sort())
  assert.deepEqual(byPredicate(result), expectation.excludedByPredicate)
})

test('the three documented claim kinds are the only thing that becomes a candidate', () => {
  const { enumerated } = runP0P1('happy-path')
  const kinds = enumerated.candidates.map((item) => item.locator.claimKind).sort()
  assert.deepEqual(kinds, ['example', 'example', 'example', 'link', 'link', 'signature'])
  // Prose is not a claim. These sentences exist in the fixture and must NOT be
  // reported: they carry no verification surface.
  for (const prose of ['Install the package:', 'Read the API reference']) {
    assert.equal(enumerated.candidates.some((item) => item.text.includes(prose)), false,
      `"${prose}" has no verification surface and must not become a candidate`)
  }
})

test('a signature claim carries the API name, so P5 has something to recompute against', () => {
  const { enumerated } = runP0P1('happy-path')
  const signatures = enumerated.candidates.filter((item) => item.locator.claimKind === 'signature')
  assert.deepEqual(signatures.map((item) => item.locator.apiName), ['computeTotal'])
  assert.deepEqual(signatures.map((item) => item.locator.anchor), ['compute-total'])
})

test('candidate ids are unique and `path` stays a gate-globable document path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'a synthetic id must never leak into candidate.path')
    assert.ok(candidate.path.endsWith('.md'), 'the path stays the document file')
  }
})

test('the source reports excluded items and notes rather than dropping them', () => {
  const enumerated = source.enumerate({
    documents: [
      { path: 'docs/empty.md', title: 'no sections', sections: [] },
      { path: 'docs/prose.md', title: 'prose', sections: [{ anchor: 'intro', text: 'Just a plain sentence.' }] },
      { path: 'docs/unanchored.md', sections: [{ text: 'See [x](./x.md).' }] }
    ],
    api: [],
  }, {})
  assert.equal(enumerated.candidates.length, 0)
  assert.ok(enumerated.excluded.some((item) => item.id === 'docs/empty.md'))
  assert.ok(enumerated.excluded.some((item) => item.id === 'docs/unanchored.md#section-1'))
  assert.ok(enumerated.notes.some((note) => note.includes('docs/prose.md')))
})

test('a per-section ceiling is enforced and reported, never silent', () => {
  const text = Array.from({ length: 20 }, (_, index) => `fn${index}(): number`).join('\n')
  const enumerated = source.enumerate({
    documents: [{ path: 'docs/many.md', sections: [{ anchor: 'all', text }] }],
    api: [],
  }, {})
  assert.equal(enumerated.candidates.length, MAX_CLAIMS_PER_SECTION)
  assert.equal(enumerated.truncated, true)
  assert.ok(enumerated.notes.some((note) => note.includes('MAX_CLAIMS_PER_SECTION')))
})

test('a candidate larger than the ceiling is removed by the too-large predicate', () => {
  const result = gate([{ path: 'docs/huge.md', bytes: 4096 }], { extensions: pack.gate.extensions, maxFileBytes: 1024 })
  assert.deepEqual(result.selected, [])
  assert.equal(result.excluded[0].predicate, 'too-large')
})

test('no fixture supplies exclude rules of its own — exclusions must come from the pack', () => {
  // t23, F1. This replaces an assertion that pinned the pack's exclude list to an
  // exact count and content ("restates defaults, plus exactly one of its own").
  // That is the "too tight" mirror of an empty assertion: it can only be green
  // while the list looks exactly as it did, so a CORRECT fix turns it red and the
  // red says nothing about whether the behaviour is right.
  //
  // The property being asserted instead is where the rules come from. A boundary
  // proven with `pack.gate.exclude ∪ fixture.gate.exclude` is a statement about
  // the test harness; the fixture's gate does not exist in production. That is
  // exactly how `**/generated/**` came to be "excluded" while the real gate
  // admitted generated code.
  const offenders = [...FIXTURES]
    .filter(([, value]) => value.gate !== undefined && (value.gate.exclude ?? []).length > 0)
    .map(([name]) => name)
  assert.deepEqual(offenders, [], 'no fixture may declare exclude rules — the rule belongs in the pack')
  for (const [name, value] of FIXTURES) {
    assert.equal(Object.hasOwn(value, 'exclude'), false, `${name} must not carry a top-level exclude`)
  }
})

test('the pack\'s OWN gate reproduces every predicate category the boundary claims', () => {
  // Property, not a count: for each predicate the boundary names, the members must
  // come out of the pack's gate exactly as claimed — and both buckets must be
  // populated by the source they name (engine defaults vs the pack's own list).
  const expectation = fixture('all-gated-out').expect
  const { result } = runP1PackOnly('all-gated-out')
  const got = byPredicate(result)

  assert.deepEqual(Object.keys(got).sort(), Object.keys(expectation.excludedByPredicate).sort(),
    'the predicate categories must be exactly the ones the boundary claims')
  for (const [predicate, paths] of Object.entries(got)) {
    assert.deepEqual(paths, [...expectation.excludedByPredicate[predicate]].sort(), `predicate ${predicate}`)
  }
  // Each bucket must be attributable: the pack's own list is what fills
  // `user-exclude`, and the engine's defaults are what fill `default-path`. An
  // empty bucket would mean one of the two sources silently stopped working.
  assert.ok(got['user-exclude'].length > 0, 'the pack\'s own rules must be doing part of the work')
  assert.ok(got['default-path'].length > 0, 'the engine defaults must still be doing their part')
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling')

test('the document resolver groups by document path, not by claim', () => {
  assert.equal(pack.bundleKey.resolve({ path: 'docs/api/reference.md' }), 'docs/api/reference.md')
  assert.equal(pack.bundleKey.resolve({ path: 'docs\\guide\\setup.md' }), 'docs/guide/setup.md')
  // The resolver must not read anything the engine refuses to forward: index.js
  // `toCandidates()` copies a fixed field set, so a resolver that wanted `meta`
  // would silently see `undefined`.
  assert.equal(pack.bundleKey.resolve({ path: 'docs/a.md', meta: { document: 'WRONG' } }), 'docs/a.md')
})

test('claims of the same document really land in the same bundle', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: pack.bundleKey.resolve(entry) }))
  const byKey = new Map()
  for (const entry of keyed) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, [])
    byKey.get(entry.key).push(entry)
  }
  assert.deepEqual([...byKey.keys()].sort(), [...fixture('happy-path').expect.bundleKeys].sort())
  assert.equal(byKey.get('docs/api/reference.md').length, 4,
    'the four claims of one document must share a bundle, not each get their own')
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
      if (entry.expectAmbiguousIn !== undefined) {
        assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
      }
      assert.equal(typeof verdict.detail, 'string', 'every unanchored verdict must explain itself')
    })
  }
}

const API = [
  {
    name: 'computeTotal',
    signature: 'computeTotal(items: Item[], options: Options = {}): number',
    params: [{ name: 'items', required: true }, { name: 'options', required: false, default: '{}' }],
    returns: 'number',
  },
]
const DOC = '## computeTotal\n\ncomputeTotal(items: Item[], options: Options = {}): number\n'

test('the signature is recomputed from the API surface, not merely found in the document', () => {
  // The excerpt IS in the document. A text search would call this anchored. The
  // signature check is what makes it an anchor: the documented signature is
  // compared against the surface's, and here they differ.
  const drifted = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', apiName: 'computeTotal', claimKind: 'signature' },
      excerpt: 'computeTotal(items: Item[]): number',
    },
    {
      path: 'docs/api/reference.md',
      content: '## computeTotal\n\ncomputeTotal(items: Item[]): number\n',
      sections: [{ anchor: 'compute-total' }],
      api: API,
    },
  )
  assert.equal(drifted.status, 'unanchored')
  assert.equal(drifted.tier, 'locator-mismatch')
  assert.match(drifted.detail, /签名/u)
  assert.match(drifted.detail, /computeTotal\(items: Item\[\]\): number/u, 'the verdict must quote both signatures')
})

test('a signature claim with no API surface is UNANCHORED — "could not check" is not "checks out"', () => {
  const verdict = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', apiName: 'computeTotal', claimKind: 'signature' },
      excerpt: 'computeTotal(items: Item[], options: Options = {}): number',
    },
    { path: 'docs/api/reference.md', content: DOC, sections: [{ anchor: 'compute-total' }] },
  )
  assert.equal(verdict.status, 'unanchored', 'a silent pass here would delete this domain\'s entire value')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /没有提供 API surface/u)
})

test('a documented parameter list that drops a required source parameter is drift', () => {
  const verdict = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', apiName: 'computeTotal', claimKind: 'signature' },
      excerpt: 'computeTotal(items: Item[]): number',
    },
    {
      path: 'docs/api/reference.md',
      content: '## computeTotal\n\ncomputeTotal(items: Item[]): number\n',
      sections: [{ anchor: 'compute-total' }],
      // Same rendered signature text, but the surface says `items` is required
      // and the document's own parameter list omits it.
      api: [{ name: 'computeTotal', signature: 'computeTotal(items: Item[]): number', params: [{ name: 'items', required: true }, { name: 'options', required: false }], returns: 'number' }],
    },
  )
  assert.equal(verdict.status, 'anchored', 'the signatures agree; only the parameter list is at issue')
  // The check that fires here is the param-list one, and it must name the param.
  const drifted = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', apiName: 'computeTotal', claimKind: 'signature' },
      excerpt: 'computeTotal(options: Options = {}): number',
    },
    {
      path: 'docs/api/reference.md',
      content: '## computeTotal\n\ncomputeTotal(options: Options = {}): number\n',
      sections: [{ anchor: 'compute-total' }],
      api: [{ name: 'computeTotal', signature: 'computeTotal(options: Options = {}): number', params: [{ name: 'items', required: true }, { name: 'options', required: false }], returns: 'number' }],
    },
  )
  assert.equal(drifted.status, 'unanchored')
  assert.equal(drifted.tier, 'locator-mismatch')
  assert.match(drifted.detail, /必填参数：items/u)
})

test('a claim naming an API the surface does not contain is refused', () => {
  const verdict = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', apiName: 'computeTotals', claimKind: 'signature' },
      excerpt: 'computeTotal(items: Item[], options: Options = {}): number',
    },
    { path: 'docs/api/reference.md', content: DOC, sections: [{ anchor: 'compute-total' }], api: API },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /API surface 里没有/u)
})

test('a paragraph anchor the document does not have is refused, when the structure is supplied', () => {
  const verdict = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'nope', claimKind: 'link' },
      excerpt: 'computeTotal(items)',
    },
    { path: 'docs/api/reference.md', content: 'computeTotal(items)\n', sections: [{ anchor: 'compute-total' }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
  assert.match(verdict.detail, /段落锚/u)

  // ... and when the structure is NOT supplied, the verdict says so instead of
  // reporting a check it never ran.
  const unchecked = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'nope', claimKind: 'link' },
      excerpt: 'computeTotal(items)',
    },
    { path: 'docs/api/reference.md', content: 'computeTotal(items)\n' },
  )
  assert.equal(unchecked.status, 'anchored')
  assert.equal(unchecked.anchorChecked, false, 'the verdict must not claim a structural check it did not run')
  assert.match(unchecked.detail, /未核验/u)
})

test('indentation is tolerated; a changed parameter type is not', () => {
  const tolerated = anchor.verify(
    { kind: 'section-and-signature', path: 'docs/a.md', locator: { docPath: 'docs/a.md', anchor: 'a' }, excerpt: '+\tcomputeTotal(items)' },
    { path: 'docs/a.md', content: 'computeTotal(items)\n', sections: [{ anchor: 'a' }] },
  )
  assert.equal(tolerated.status, 'anchored')
  assert.equal(tolerated.tier, 'recomputed-unique')

  const changed = anchor.verify(
    { kind: 'section-and-signature', path: 'docs/a.md', locator: { docPath: 'docs/a.md', anchor: 'a' }, excerpt: 'computeTotal(entries)' },
    { path: 'docs/a.md', content: 'computeTotal(items)\n', sections: [{ anchor: 'a' }] },
  )
  assert.equal(changed.status, 'unanchored')
  assert.equal(changed.tier, 'no-match')
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { kind: 'section-and-signature', path: 'docs/a.md', locator: { docPath: 'docs/a.md', anchor: 'a', startLine: 99 }, excerpt: 'computeTotal(items)' },
    { path: 'docs/a.md', content: 'computeTotal(items)\n', sections: [{ anchor: 'a' }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'docs/a.md', locator: {}, excerpt: 'computeTotal(items)' },
    { path: 'docs/a.md', content: 'computeTotal(items)\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('an empty excerpt is refused: there is nothing to verify, so nothing is verified', () => {
  const verdict = anchor.verify(
    { kind: 'section-and-signature', path: 'docs/a.md', locator: { docPath: 'docs/a.md', anchor: 'a' }, excerpt: '   \n\n  ' },
    { path: 'docs/a.md', content: 'computeTotal(items)\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'empty-excerpt')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'section-and-signature' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'section-and-signature', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['docs/api/reference.md'],
  bundle: { key: 'docs/api/reference.md', paths: ['docs/api/reference.md'], rules: ['signature-drift'] },
  ruleText: '<rules path="docs/api/reference.md">\n签名漂移：文档中的函数签名与源码是否一致。\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    {
      id: 'f1',
      path: 'docs/api/reference.md',
      evidence: 'computeTotal(items: Item[]): number',
      message: '文档漏掉了 options 参数',
      defended: true,
    },
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
  assert.match(P4.system, /签名漂移/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /签名漂移/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts repeat the anchor law: quote the text, never the line number', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /行号/u)
  }
  assert.match(P4.system, /不要输出行号|永远不要输出行号/u)
})

test('precision-first is stated in both prompts, so the domain cannot be silently flipped', () => {
  assert.match(P4.system, /precision-first/u)
  assert.match(P6.system, /precision-first/u)
  const flipped = prompts.review({ ...reviewContext, orientation: 'recall-first' })
  assert.notEqual(flipped.system, P4.system)
  assert.match(flipped.system, /recall-first/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const DOCS = [
  {
    path: 'docs/a.md',
    title: 'A',
    sections: [
      { anchor: 'intro', text: 'hello\nneedle here\nbye' },
      { anchor: 'usage', text: 'computeTotal(items)' },
    ],
  },
  { path: 'docs/b.md', title: 'B', sections: [{ anchor: 'only', text: 'needle also here' }] },
]
const API_SURFACE = [{ name: 'computeTotal', signature: 'computeTotal(items)', params: [{ name: 'items', required: true }], returns: 'number' }]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('read_section returns at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('read_section')
  const big = [{ path: 'docs/big.md', sections: [{ anchor: 'all', text: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }] }]
  const result = await tool.execute({ path: 'docs/big.md', documents: big }, {})
  assert.ok(result.items.length <= tool.limits.maxLines, `${result.items.length} > ${tool.limits.maxLines}`)
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.equal(typeof result.provenance, 'string')
  assert.ok(result.provenance.length > 0)
})

await testAsync('read_section scopes to a paragraph anchor and names it in the provenance', async () => {
  const tool = toolByName('read_section')
  const result = await tool.execute({ path: 'docs/a.md', anchor: 'intro', documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => item.text), ['hello', 'needle here', 'bye'])
  assert.match(result.provenance, /#intro/u)
  assert.equal(result.truncated, false)
})

await testAsync('read_section refuses an anchor the document does not have, listing the real ones', async () => {
  const tool = toolByName('read_section')
  assert.throws(() => tool.execute({ path: 'docs/a.md', anchor: 'nope', documents: DOCS }, {}), /没有段落锚 "nope"/u)
})

await testAsync('api_lookup answers with the signature the verifier will compare against', async () => {
  const tool = toolByName('api_lookup')
  const result = await tool.execute({ name: 'computeTotal', api: API_SURFACE, documents: DOCS }, {})
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].signature, 'computeTotal(items)')
  assert.deepEqual(result.items[0].mentionedIn, ['docs/a.md#usage'])
  assert.match(result.provenance, /精确/u)
})

await testAsync('api_lookup caps its hit count and reports the cap', async () => {
  const tool = toolByName('api_lookup')
  const many = Array.from({ length: 200 }, (_, index) => ({ name: `fn${index}`, signature: `fn${index}()` }))
  const result = await tool.execute({ name: 'fn', api: many }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('search_docs reports every hit with its paragraph anchor, bounded', async () => {
  const tool = toolByName('search_docs')
  const result = await tool.execute({ pattern: 'needle', documents: DOCS }, {})
  assert.deepEqual(result.items.map((item) => `${item.path}#${item.anchor}:${item.line}`), ['docs/a.md#intro:2', 'docs/b.md#only:1'])
  assert.equal(result.truncated, false)
  assert.match(result.provenance, /2 个文档/u)
})

await testAsync('search_docs caps its hit count and says so', async () => {
  const tool = toolByName('search_docs')
  const many = [{ path: 'docs/many.md', sections: [{ anchor: 'all', text: Array.from({ length: 500 }, () => 'needle').join('\n') }] }]
  const result = await tool.execute({ pattern: 'needle', documents: many }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('a request naming an absent document fails loudly with the available paths', async () => {
  const tool = toolByName('read_section')
  // The tool throws synchronously: the contract's failure mode is a throw, and
  // `assert.throws` is the assertion that proves it. `assert.rejects` would
  // pass for a tool that merely returned a rejected promise.
  assert.throws(() => tool.execute({ path: 'docs/nope.md', documents: DOCS }, {}), /文档集里没有 "docs\/nope\.md"/u)
})

await testAsync('a request with no context at all is refused, not answered with "nothing found"', async () => {
  assert.throws(() => toolByName('read_section').execute({ path: 'docs/a.md' }, {}), /缺少 `documents`/u)
  assert.throws(() => toolByName('search_docs').execute({ pattern: 'x' }, {}), /缺少 `documents`/u)
  assert.throws(() => toolByName('api_lookup').execute({ name: 'computeTotal' }, {}), /缺少 `api`/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('tech-doc', 'api_lookup'), 'adjudicate_tech_doc_evidence_api_lookup')
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
                path: 'docs/api/reference.md',
                evidence: 'computeTotal(items: Item[]): number',
                message: '文档漏掉了 options 参数',
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
  const bundles = fixture('happy-path').expect.bundleKeys.map((key) => ({
    key,
    entries: result.selected.filter((entry) => pack.bundleKey.resolve(entry) === key),
  }))
  const budget = createBudget({ maxToolCalls: 50 })
  const outcome = await reasoner.run({
    pack: { ...pack, reviewPrompts: prompts },
    target: 'fixture happy-path',
    bundles,
    budget,
    getBudget: () => budget,
    onCharge: () => {},
  })

  assert.equal(outcome.mode, 'subagents')
  assert.equal(outcome.rounds, bundles.length, 'one bounded pass per bundle')
  assert.ok(requests.length >= 1, 'the reasoner must actually call the child')
  assert.match(requests[0].prompt[0].text, /技术文档/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /不要输出行号/u, 'the anchor law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6 / P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(5, [{ path: 'docs/a.md' }, { path: 'docs/b.md' }, { path: 'docs/a.md' }])
  assert.equal(proof.total, 5)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, 0.4)
  assert.equal(proof.complete, false)
  assert.equal(coverage(5, [{ path: 'docs/a.md' }], { requireComplete: true }).required, true)
})

test('precision-first keeps only what the evidence proves, and drops the rest', () => {
  const panel = runCritiquePanel([
    { id: 'proven', path: 'docs/a.md', start: 1, severity: 'high', evidence: 'computeTotal(items)', defended: true },
    { id: 'bare', path: 'docs/a.md', start: 2, severity: 'low', evidence: '' },
    { id: 'undefended', path: 'docs/a.md', start: 3, severity: 'low', evidence: 'x' },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['proven'])
  assert.deepEqual(panel.dropped.map((item) => item.id).sort(), ['bare', 'undefended'])
  assert.equal(panel.kind, 'fact-checker')
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  // The anchors are REAL: they come from `anchor.verify` over the fixture's own
  // text, not from a hand-written `anchored: true`.
  const happy = fixture('happy-path')
  const good = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', apiName: 'computeTotal', claimKind: 'signature' },
      excerpt: 'computeTotal(items: Item[], options: Options = {}): number',
    },
    {
      path: 'docs/api/reference.md',
      content: '## computeTotal\n\ncomputeTotal(items: Item[], options: Options = {}): number\n',
      sections: [{ anchor: 'compute-total' }],
      api: happy.input.payload.api,
    },
  )
  const bad = anchor.verify(
    {
      kind: 'section-and-signature',
      path: 'docs/api/reference.md',
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', claimKind: 'signature' },
      excerpt: 'computeTotal(items: Item[]): number',
    },
    {
      path: 'docs/api/reference.md',
      content: '## computeTotal\n\ncomputeTotal(items: Item[], options: Options = {}): number\n',
      sections: [{ anchor: 'compute-total' }],
    },
  )
  assert.equal(good.status, 'anchored')
  assert.equal(bad.status, 'unanchored')

  const anchored = [good, bad].filter((verdict) => verdict.status === 'anchored')
  assert.equal(anchored.length, 1)
  const proof = coverage(2, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.5, 'the unanchored path must not be counted as reviewed')
  assert.equal(proof.complete, false)
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 'docs/a.md', start: 1, severity: 'high', evidence: 'x', defended: true }],
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
  assert.equal(built.domain, 'tech-doc')
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

const packageIo = () => createNodeIo({ baseUrl: new URL('../../', import.meta.url).href })

/**
 * Every domain directory that actually exists on disk, derived from the LIVE
 * directory listing using the loader's own discovery rule (directory +
 * kebab-case id + a sibling index.js).
 *
 * WHY THIS IS DERIVED AND NOT HARD-CODED: `assert.deepEqual(found, ['tech-doc'])`
 * would assert "how many domains exist TODAY", not "what the rule is". It was
 * true only on the day it was written, and went red the moment a second domain
 * owner created their directory — for a reason that had nothing to do with
 * their work. The rule the loader promises is domain-count independent: every
 * qualifying directory is discovered, none is silently skipped, each loaded
 * pack is accounted for exactly once.
 */
const DOMAIN_DIRECTORY_IDS = readdirSync(join(here, '..'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9-]*$/u.test(entry.name))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(here, '..', name, 'index.js')))
  .sort()

/**
 * The accounting invariant that replaces "this domain is the only one in the
 * package". A sibling that is mid-flight (a directory exists but its pack does
 * not yet pass `validateDomainPackV2`) is *correctly* skipped with a readable
 * reason — that is the loader working, not a domain going missing.
 */
function assertEveryDirectoryAccountedFor(result, extraIds = []) {
  const loaded = result.packs.map((item) => item.id)
  const skipped = result.skipped.map((entry) => entry.id)
  const accounted = new Set([...loaded, ...skipped])
  for (const id of [...DOMAIN_DIRECTORY_IDS, ...extraIds]) {
    assert.equal(accounted.has(id), true, `domain directory "${id}" vanished: it is neither loaded nor skipped`)
  }
  assert.equal(accounted.size, loaded.length + skipped.length, 'no directory may be counted twice')
  for (const entry of result.skipped) {
    assert.equal(typeof entry.id === 'string' && entry.id !== '', true, 'every skip names an id')
    const reason = typeof entry.reason === 'string' ? entry.reason : entry.problems?.join('; ')
    assert.equal(typeof reason === 'string' && reason !== '', true, `skipped directory "${entry.id}" must carry a reason`)
  }
}

await testAsync('loadDomain assembles all five extension points from the sibling files', async () => {
  const io = await packageIo()
  const loaded = await loadDomain(io, { id: 'tech-doc', dir: 'domains/tech-doc' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'doc-claims')
  assert.equal(assembled.anchorVerifier.kind, 'section-and-signature')
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
  const discovery = discoverDomains(io, { root: 'domains' })
  assert.ok(discovery.found.some((entry) => entry.id === 'tech-doc'), 'this domain must be discovered')
  const foundIds = new Set(discovery.found.map((entry) => entry.id))
  for (const entry of discovery.skipped) {
    const reason = typeof entry.reason === 'string' ? entry.reason : entry.problems?.join('; ')
    assert.equal(typeof reason === 'string' && reason !== '', true, `scan-level skip "${entry.id}" must carry a reason`)
    assert.equal(foundIds.has(entry.id), false, `"${entry.id}" cannot be both found and skipped`)
  }

  const result = await loadDomains(io, { root: 'domains' })
  assert.deepEqual(result.problems.filter((entry) => entry.id === 'tech-doc'), [], JSON.stringify(result.problems))
  assertEveryDirectoryAccountedFor(result)
  assert.equal(result.packs.some((item) => item.id === 'tech-doc'), true, 'this domain must load')
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
  assertEveryDirectoryAccountedFor(result, ['bad-domain'])
  assert.equal(result.packs.some((item) => item.id === 'bad-domain'), false, 'the broken sibling must not load')
  const broken = result.skipped.filter((entry) => entry.id === 'bad-domain')
  assert.equal(broken.length, 1, 'the broken sibling must be skipped exactly once')
  assert.match(broken[0].reason, /invalid v2 pack/u)
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
    domain: 'tech-doc',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'doc-claims')
  assert.equal(plan.candidateSet.inputFormat, 'doc-corpus-and-api-surface')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true, 'the v2 object form must actually take effect')
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.derived, happy.expect.admitted)
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), [...happy.expect.bundleKeys].sort())
  const biggest = plan.bundles.find((item) => item.key === 'docs/api/reference.md')
  assert.equal(biggest.paths.length, 4, 'grouping must be real, not one candidate per bundle')
  assert.equal(plan.criticism.kind, 'fact-checker')
  assert.match(plan.summary, /复核者：fact-checker/u)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'tech-doc',
    target: 'fixture empty',
    input: { format: empty.input.format, payload: empty.input.payload },
  }, {})
  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /不要凭空审核/u)
})

await testAsync('adjudication_submit recomputes the signature before it accepts a finding', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'tech-doc',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  const documents = [{ path: 'docs/api/reference.md', content: '## computeTotal\n\ncomputeTotal(items: Item[], options: Options = {}): number\n' }]

  // t17: `adjudication_submit` recomputes every anchor itself and ignores the
  // caller's `anchored`/`start`. The second finding's excerpt IS in the document
  // but its signature disagrees with the API surface — so it must be judged
  // unanchored even though a plain text search would have accepted it.
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'tech-doc',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    documents,
    findings: [
      {
        id: 'f1',
        path: 'docs/api/reference.md',
        excerpt: 'computeTotal(items: Item[], options: Options = {}): number',
        anchored: true,
        start: 3,
        severity: 'high',
        message: '文档的签名与实现不一致',
        evidence: 'computeTotal(items: Item[], options: Options = {}): number',
        defended: true,
      },
      {
        id: 'f2',
        path: 'docs/api/reference.md',
        excerpt: 'computeTotal(items: Item[]): number',
        anchored: true,
        start: 3,
        severity: 'high',
        message: '文档没写 options',
        evidence: 'computeTotal(items: Item[]): number',
        defended: true,
      },
    ],
  }, {})

  // Both excerpts are IN the caller-supplied documents text? No — only the first
  // is; the second is not present at all, so it cannot even be located. Either
  // way, the caller's `anchored: true` is ignored.
  assert.equal(submitted.unanchored, 1, 'the self-reported anchor must not buy the second finding a pass')
  assert.equal(submitted.coverage.reviewed, 1)
  assert.equal(submitted.criticismKind, 'fact-checker')
  assert.match(submitted.summary, /复核者：fact-checker/u)
})

// ---------------------------------------------------------------------------
// The engine boundary: the domain locator must SURVIVE the trip
// ---------------------------------------------------------------------------

console.log('\nthe engine boundary — the domain locator must arrive intact')

// ADDED (t20). Everything above this point tests the domain in isolation, with
// `anchor.verify` called directly. That is not enough, and the reason is
// historical: `recomputeAnchor` in `index.js` USED TO rebuild the claim from the
// engine's generic anchor vocabulary, producing
// `{kind, path, locator:{start, startLine, end, endLine}, excerpt}` and dropping
// `finding.locator` entirely. A domain-shaped locator — `{docPath, anchor,
// apiName}` here, `{moduleId, targetId}` in architecture, `{operator, backend,
// dtype, shapeBranch}` in operator-design — never reached the verifier, so
// sixteen of the nineteen domains would have scored zero coverage forever.
//
// That engine behaviour is GONE. `index.js:734` ("CHANGED (t17, second pass)")
// passes the caller's `locator` through VERBATIM and folds the top-level
// `start`/`end` in ONLY when the caller supplied no locator at all — so a
// verifier's own "empty claim" detection still works, and no engine-invented key
// is ever mixed into a domain's shape. The two probes below are what keep that
// true: they are the only assertions in this file that cross the engine boundary,
// and a refactor that reintroduces locator reconstruction turns them red.

await testAsync('the engine hands this domain\'s verifier the caller\'s locator VERBATIM, not a rebuilt one', async () => {
  const ctx = createPluginContext()
  const locator = { docPath: 'docs/api/reference.md', anchor: 'compute-total', apiName: 'computeTotal', claimKind: 'signature' }

  // `adjudication_anchor` returns the claim the engine actually constructed, so
  // this reads the boundary itself instead of inferring it from a verdict.
  const anchored = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'tech-doc',
    path: 'docs/api/reference.md',
    excerpt: 'computeTotal(items: Item[], options: Options = {}): number',
    locator,
    documents: [{ path: 'docs/api/reference.md', content: '## computeTotal\n\ncomputeTotal(items: Item[], options: Options = {}): number\n' }],
  }, {})

  assert.equal(anchored.via, 'anchorVerifier', 'the engine must route through the pack anchorVerifier')
  assert.deepEqual(anchored.claim.locator, locator,
    'the locator must arrive byte-for-byte; a rebuilt {start,startLine,end,endLine} would prove the old defect is back')
  assert.equal(anchored.claim.kind, 'section-and-signature')
  assert.equal(anchored.claim.path, 'docs/api/reference.md')
})

await testAsync('a finding carrying this domain\'s locator is anchored THROUGH adjudication_submit and counted in coverage', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'tech-doc',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  const documents = [{ path: 'docs/api/reference.md', content: '## computeTotal\n\ncomputeTotal(items: Item[], options: Options = {}): number\n' }]

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'tech-doc',
    target: 'fixture happy-path',
    documents,
    findings: [{
      id: 'f-located',
      path: 'docs/api/reference.md',
      excerpt: 'computeTotal(items: Item[], options: Options = {}): number',
      evidence: 'computeTotal(items: Item[], options: Options = {}): number',
      // `apiName` is deliberately omitted: it would require `subject.api`, and a
      // signature claim is the subject of a DIFFERENT assertion. `line` is what
      // makes this decisive — the verifier reads `locator.startLine ?? locator.line`
      // as a DECLARED position, so under the old engine (empty locator -> nothing
      // declared) the tier below would have been `recomputed-unique`.
      locator: { docPath: 'docs/api/reference.md', anchor: 'compute-total', line: 3 },
      severity: 'high',
      message: '文档里的签名与实现不一致',
      defended: true,
    }],
  }, {})

  assert.equal(submitted.anchorVia, 'anchorVerifier')
  assert.equal(submitted.unanchored, 0, 'a finding that carries a locator the verifier can use must anchor')
  assert.equal(submitted.findings.length, 1)
  const finding = submitted.findings[0]
  assert.equal(finding.anchored, true)
  assert.equal(finding.anchorTier, 'declared-locator',
    'the caller declared line 3 inside the locator, so the verifier confirms a DECLARED position instead of re-deriving one')
  assert.ok(TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier))
  assert.equal(finding.anchorLocator.docPath, 'docs/api/reference.md')
  assert.equal(finding.anchorLocator.anchor, 'compute-total')

  assert.equal(submitted.coverage.total, plan.gate.admitted)
  assert.equal(submitted.coverage.reviewed, 1, 'the anchored path must be counted as reviewed')
  assert.equal(submitted.coverage.coverageRate, Number((1 / plan.gate.admitted).toFixed(4)))
  assert.equal(submitted.coverage.totalSource, 'plan')
})

await testAsync('adjudication_activate registers this domain\'s own tool names', async () => {
  const ctx = createPluginContext()
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.ok(listed.domains.some((item) => item.id === 'tech-doc'), 'tech-doc must be in the registry')
  const directory = listed.directory
  assert.ok(directory !== null, 'the directory report must be present once directory domains exist')
  assert.ok(directory.loaded.includes('tech-doc'), `loaded: ${directory.loaded.join(', ')}`)
  assert.deepEqual(directory.problems.filter((entry) => entry.id === 'tech-doc'), [])

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'tech-doc' }, {})
  assert.equal(activated.ok, true, activated.summary)
  for (const name of ['adjudicate_tech_doc', 'adjudicate_tech_doc_plan', 'adjudicate_tech_doc_rules']) {
    assert.ok(ctx.__tools.has(name), `missing tool ${name}`)
  }
})

// ---------------------------------------------------------------------------

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) {
  console.log('failed:')
  for (const title of failedTitles) console.log(`  - ${title}`)
  process.exitCode = 1
}
