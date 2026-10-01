/**
 * ui-visual — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  one candidate per hardcoded (layer, prop)
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey                  ->  real grouping BY COMPONENT, not by path
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  layer + prop + TOKEN TABLE + evidence
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
 *    the end-to-end part comes out of this domain's own `anchor.verify()` first.
 *
 * Usage: `node domains/ui-visual/test.mjs`
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
import anchor, { contrastLevel, contrastRatio, relativeLuminance } from './anchor.js'
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

const countByComponent = (candidates) => {
  const counts = {}
  for (const candidate of candidates) {
    const id = candidate.meta?.componentScope ?? '(none)'
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\nui-visual domain — contract v2 end-to-end')
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
  const declared = inputFormatFor('ui-visual')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(declared.format, 'design-tokens-and-layers')
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(declared.bounded, true)
  assert.equal(source.bounded, true)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.kind, 'layer-and-token')
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

test('the three rules that carry the computable requirements exist and demand a number', () => {
  for (const name of ['token-adherence', 'contrast-text', 'focus-visible']) {
    const text = readFileSync(join(here, 'rules', `${name}.md`), 'utf8')
    assert.match(text, /needs-expert-review: true/u)
  }
  const contrast = readFileSync(join(here, 'rules', 'contrast-text.md'), 'utf8')
  assert.match(contrast, /4\.5:1/u, 'the contrast rule must state the threshold it is measured against')
  assert.match(contrast, /计算出的比值/u, 'the contrast rule must demand a computed ratio, not a qualitative claim')
})

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'dark-only', match: ['**/dark/**'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**'], text: 'y'.repeat(20) },
  ], ['atoms/btn-primary/bg-color'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('rule selection over the real library injects every matching rule exactly once', () => {
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = /^name:\s*(.+)$/mu.exec(text)?.[1]?.trim()
    const match = [...text.matchAll(/^\s+- "(.+)"$/gmu)].map((hit) => hit[1])
    return { name, match, text: 'body' }
  })
  const { injected } = selectRules(rules, ['atoms/btn-primary/bg-color'])
  const names = injected.map((rule) => rule.name)
  assert.ok(names.includes('token-adherence'))
  assert.ok(names.includes('contrast-text'))
  assert.equal(new Set(names).size, names.length, 'no rule may be injected twice')
  assert.equal(names.length, rules.length, 'every rule in this library matches every layer path ("**")')
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  assert.ok(FIXTURES.has('hardcoded-value'), 'this domain must ship the class the contract table names')
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

test('boundary: empty token and layer tables produce an EMPTY candidate set', () => {
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

test('happy path: every hardcoded property is admitted, and the per-component split is real', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
  assert.deepEqual(countByComponent(enumerated.candidates), expected.componentCounts)
})

test('a layer whose properties ALL reference tokens contributes no candidate, and says so', () => {
  const expected = fixture('happy-path').expect
  const { enumerated } = runP0P1('happy-path')
  const shell = enumerated.candidates.filter((candidate) => candidate.meta.layerId === expected.fullyTokenisedLayer)
  assert.deepEqual(shell, [], 'a fully tokenised layer is the desired state, not a candidate')
  assert.ok(
    enumerated.notes.some((note) => note.includes(expected.fullyTokenisedLayer) && note.includes('期望状态')),
    `the fully tokenised layer must be reported in notes: ${JSON.stringify(enumerated.notes)}`,
  )
  const allIds = enumerated.candidates.map((candidate) => candidate.meta.layerId)
  assert.ok(!allIds.includes(expected.fullyTokenisedLayer))
})

test('a broken token reference is REPORTED as an exclusion, because it is a defect but not a hardcoded value', () => {
  const expected = fixture('hardcoded-value').expect
  const { enumerated, result } = runP0P1('hardcoded-value')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path).sort(), [...expected.paths].sort())
  assert.equal(result.selected.length, expected.admitted)
  const broken = enumerated.excluded.find((entry) => entry.id === 'ghost.bg-color')
  assert.ok(broken !== undefined, 'the broken token reference must appear in excluded')
  assert.equal(broken.reason, expected.excludedBySource['ghost.bg-color'])
})

test('a hardcoded value resolves to the token that carries the same value', () => {
  const { enumerated } = runP0P1('hardcoded-value')
  assert.equal(enumerated.candidates[0].meta.tokenName, 'brand-primary')
  assert.equal(enumerated.candidates[0].locator.tokenName, 'brand-primary')
})

test('the gate is the engine\'s ordered predicate list, and the pack only narrows it', () => {
  assert.deepEqual(gate([], {}).ordered, DEFAULT_GATE_PREDICATES.map(([label]) => label))
  assert.deepEqual(pack.gate.exclude, ['**/.git/**', '**/dist/**', '**/build/**', '**/deprecated/**'])
  for (const pattern of pack.gate.exclude) {
    assert.ok(DEFAULT_EXCLUDE_PATTERNS.includes(pattern) || ['**/build/**', '**/deprecated/**'].includes(pattern),
      `"${pattern}" is not one of the engine's default patterns — justify it or drop it`)
  }
  assert.ok(!pack.gate.exclude.includes('**/node_modules/**'), 'node_modules is covered by default-path')
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ tokens: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ layers: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ tokens: 'nope', layers: [] }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ tokens: {}, layers: [] }, {}))
})

test('candidate ids are unique, paths are gate-globable, and the component leads the path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.match(candidate.path, /^[a-z0-9][a-z0-9._:/-]*$/u, `${candidate.id} path must be globbable`)
    assert.equal(candidate.path.split('/')[0], candidate.meta.componentScope)
    assert.equal(typeof candidate.locator.layerId, 'string', `${candidate.id} needs the layer half`)
    assert.equal(typeof candidate.locator.prop, 'string', `${candidate.id} needs the property half`)
  }
})

test('the source reports malformed layers and un-inspectable ones rather than dropping them', () => {
  const enumerated = source.enumerate({
    tokens: { color: { surface: { value: '#ffffff' } } },
    layers: [{ id: 'no-props', component: 'atoms' }, { component: 'atoms', props: { 'bg-color': '#ffffff' } }, 'nope'],
  }, {})
  assert.equal(enumerated.candidates.length, 0)
  const reasons = enumerated.excluded.map((entry) => entry.reason)
  assert.ok(reasons.some((reason) => /缺少 props/u.test(reason)), JSON.stringify(reasons))
  assert.ok(reasons.some((reason) => /缺少 id/u.test(reason)), JSON.stringify(reasons))
  assert.ok(reasons.some((reason) => /不是对象/u.test(reason)), JSON.stringify(reasons))
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling by component (not by path)')

test('bundleKey resolves through the contract helper and is APPLIED', () => {
  const { result } = runP0P1('happy-path')
  for (const entry of result.selected) {
    const resolution = resolveBundleKey(pack, entry, {})
    assert.equal(resolution.applied, true, resolution.reason)
    assert.equal(resolution.source, 'derived')
    assert.equal(resolution.strategy, 'component')
  }
})

test('the multi-component design really splits into one bundle PER COMPONENT', () => {
  const expected = fixture('happy-path').expect
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: resolveBundleKey(pack, entry, {}).key }))
  const bundled = bundle(keyed)
  assert.deepEqual(bundled.bundles.map((item) => item.key).sort(), expected.bundleKeys)
  assert.equal(bundled.bundles.length, 3)
  assert.notEqual(bundled.strategy, 'short-circuit-single')
})

test('two properties of the SAME component land in one bundle (not just applied:true)', () => {
  const { result } = runP0P1('happy-path')
  const keyed = result.selected.map((entry) => ({ ...entry, key: resolveBundleKey(pack, entry, {}).key }))
  const bundled = bundle(keyed)

  const molecules = bundled.bundles.find((item) => item.key === 'molecules')
  assert.ok(molecules !== undefined, 'the molecules component must form its own bundle')
  assert.equal(molecules.entries.length, 3)
  assert.equal(new Set(molecules.entries.map((entry) => entry.meta.layerId)).size, 2, 'two layers of one component')
  assert.equal(new Set(molecules.entries.map((entry) => entry.meta.prop)).size, 3)

  for (const item of bundled.bundles) {
    assert.equal(new Set(item.entries.map((entry) => entry.meta.componentScope)).size, 1,
      `bundle "${item.key}" mixed components: ${item.entries.map((entry) => entry.meta.componentScope).join(' | ')}`)
  }
})

// ---------------------------------------------------------------------------
// P5 — the anchor verifier, positive and negative
// ---------------------------------------------------------------------------

console.log('\nP5 — anchors (layer + prop + token table + evidence)')

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
      if (entry.expectToken !== undefined) assert.equal(verdict.token, entry.expectToken,
        'an anchored verdict must name the token it recomputed against the token table')
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
      assert.equal(verdict.token, null)
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

// --- the token-table recomputation, fact by fact ----------------------------

const TOKENS = { color: { 'brand-primary': { value: '#2563eb' }, surface: { value: '#ffffff' } } }
const LAYERS = [{ id: 'btn', props: { 'bg-color': '#2563eb' } }]
const VISUAL_DOC = [{ path: 'atoms/btn/bg-color', content: '属性 bg-color = #2563eb\n' }]
const VISUAL_SUBJECT = { path: 'atoms/btn/bg-color', tokens: TOKENS, layers: LAYERS, documents: VISUAL_DOC }

test('TOKEN HALF: a token name the table does not contain is refused, never approximated', () => {
  const verdict = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/btn/bg-color', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-tertiary' }, excerpt: '属性 bg-color = #2563eb' },
    VISUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /brand-tertiary/u)
})

test('LAYER HALF: an unknown layer or property is refused', () => {
  assert.equal(anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/nope/bg-color', locator: { layerId: 'nope', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '属性 bg-color = #2563eb' },
    VISUAL_SUBJECT,
  ).tier, 'no-match')
  assert.equal(anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/btn/shadow', locator: { layerId: 'btn', prop: 'shadow', tokenName: 'brand-primary' }, excerpt: '属性 bg-color = #2563eb' },
    VISUAL_SUBJECT,
  ).tier, 'no-match')
})

test('MISSING MATERIAL: without both halves — and without a candidate set — the anchor still refuses', () => {
  const claim = {
    kind: 'layer-and-token',
    path: 'atoms/btn/bg-color',
    locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' },
    excerpt: '属性 bg-color = #2563eb',
  }
  // Neither half: the line-range surface the engine used to hand over. This is
  // the shape that made every plugin-path anchor score 0 before t27 — it must
  // stay a refusal now that a candidate set can rebuild the tables.
  const neither = anchor.verify(claim, { path: 'atoms/btn/bg-color', documents: [{ path: 'atoms/btn/bg-color', content: '属性 bg-color = #2563eb\n' }] })
  assert.equal(neither.status, 'unanchored')
  assert.equal(neither.tier, 'no-documents')

  // Only the layer half: the token side is required, so this is still nothing to
  // recompute against rather than a partial match.
  const layersOnly = anchor.verify(claim, { path: 'atoms/btn/bg-color', layers: LAYERS, documents: [{ path: 'atoms/btn/bg-color', content: '属性 bg-color = #2563eb\n' }] })
  assert.equal(layersOnly.status, 'unanchored')
  assert.equal(layersOnly.tier, 'no-documents')
  assert.match(layersOnly.detail, /token 表 缺失/u)

  // Only the token half: same answer, and the detail names the missing half.
  const tokensOnly = anchor.verify(claim, { path: 'atoms/btn/bg-color', tokens: TOKENS, documents: [{ path: 'atoms/btn/bg-color', content: '属性 bg-color = #2563eb\n' }] })
  assert.equal(tokensOnly.status, 'unanchored')
  assert.equal(tokensOnly.tier, 'no-documents')
  assert.match(tokensOnly.detail, /图层表 缺失/u)

  // An empty candidate set is NOT material: it rebuilds neither half.
  const emptySet = anchor.verify(claim, { path: 'atoms/btn/bg-color', candidates: [], documents: [{ path: 'atoms/btn/bg-color', content: '属性 bg-color = #2563eb\n' }] })
  assert.equal(emptySet.status, 'unanchored')
  assert.equal(emptySet.tier, 'no-documents')
})

test('CONTRADICTION: a layer that already references a token cannot be called hardcoded', () => {
  const verdict = anchor.verify(
    { kind: 'layer-and-token', path: 'layouts/shell/bg-color', locator: { layerId: 'shell', prop: 'bg-color', tokenName: 'surface' }, excerpt: '属性 bg-color = #ffffff' },
    {
      path: 'layouts/shell/bg-color',
      tokens: TOKENS,
      layers: [{ id: 'shell', props: { 'bg-color': '#ffffff' }, tokenRefs: { 'bg-color': 'surface' } }],
      documents: [{ path: 'layouts/shell/bg-color', content: '属性 bg-color = #ffffff\n' }],
    },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /正面矛盾/u)
})

test('ALL FOUR hold -> anchored, and the verdict names the token it recomputed', () => {
  const verdict = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/btn/bg-color', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '属性 bg-color = #2563eb' },
    VISUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'anchored')
  assert.equal(verdict.tier, 'recomputed-unique')
  assert.equal(verdict.token, 'brand-primary')
  assert.equal(verdict.start, 1)
})

test('a paraphrase never anchors, even when the intent is obvious', () => {
  const verdict = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/btn/bg-color', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '背景色被写死成了 #2563eb' },
    VISUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/btn/bg-color', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary', startLine: 99 }, excerpt: '属性 bg-color = #2563eb' },
    VISUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('indentation is tolerated; punctuation is not', () => {
  const tolerated = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/btn/bg-color', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '  属性   bg-color   =   #2563eb' },
    VISUAL_SUBJECT,
  )
  assert.equal(tolerated.status, 'anchored')

  const punctuation = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/btn/bg-color', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '属性 bg-color = #2563EB' },
    VISUAL_SUBJECT,
  )
  assert.equal(punctuation.status, 'unanchored', 'a changed hex literal is a changed line')
})

test('a cross-file relocation must be unique, and the competing locations are listed', () => {
  const documents = [
    { path: 'atoms/one/x', content: '属性 bg-color = #2563eb\n' },
    { path: 'atoms/two/x', content: '属性 bg-color = #2563eb\n' },
  ]
  const ambiguous = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/missing/x', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '属性 bg-color = #2563eb' },
    { path: 'atoms/missing/x', tokens: TOKENS, layers: LAYERS, documents },
  )
  assert.equal(ambiguous.status, 'unanchored')
  assert.equal(ambiguous.tier, 'relocation-ambiguous')
  assert.deepEqual(ambiguous.ambiguousIn, ['atoms/one/x:1', 'atoms/two/x:1'])

  const unique = anchor.verify(
    { kind: 'layer-and-token', path: 'atoms/missing/x', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '属性 bg-color = #2563eb' },
    { path: 'atoms/missing/x', tokens: TOKENS, layers: LAYERS, documents: [documents[0]] },
  )
  assert.equal(unique.status, 'anchored')
  assert.equal(unique.tier, 'relocated-unique')
  assert.equal(unique.path, 'atoms/one/x')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'flow-step-and-node', path: 'atoms/btn/bg-color', locator: { layerId: 'btn', prop: 'bg-color', tokenName: 'brand-primary' }, excerpt: '属性 bg-color = #2563eb' },
    VISUAL_SUBJECT,
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'layer-and-token' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'layer-and-token', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P5b — contrast is a computed NUMBER, not a qualitative description
// ---------------------------------------------------------------------------

console.log('\nP5b — WCAG contrast must be a recomputable ratio')

test('contrastRatio returns a recomputable 2-decimal number', () => {
  assert.equal(typeof contrastRatio('#767676', '#ffffff'), 'number')
  assert.equal(contrastRatio('#767676', '#ffffff'), 4.54, 'WCAG 2.x relative luminance, rounded to 2 decimals')
  assert.equal(contrastRatio('#ffffff', '#000000'), 21)
  assert.equal(contrastRatio('#111827', '#111827'), 1)
  assert.equal(contrastRatio('#000000', '#ffffff'), contrastRatio('#ffffff', '#000000'), 'the ratio is symmetric')
  assert.equal(Number(contrastRatio('#767676', '#ffffff').toFixed(2)), contrastRatio('#767676', '#ffffff'))
})

test('the ratio is derived from relative luminance, so a known pair lands where WCAG says it does', () => {
  const white = relativeLuminance('#ffffff')
  const black = relativeLuminance('#000000')
  assert.equal(white, 1)
  assert.equal(black, 0)
  assert.ok(contrastRatio('#cccccc', '#ffffff') < 3, 'light grey on white fails the 3:1 non-text threshold too')
  assert.ok(contrastRatio('#767676', '#ffffff') >= 4.5, 'and this one just clears AA for body text')
})

test('contrastLevel maps a ratio to the WCAG level', () => {
  assert.equal(contrastLevel(4.54), 'AA')
  assert.equal(contrastLevel(3.2), 'AA-large')
  assert.equal(contrastLevel(1.61), 'fail')
  assert.equal(contrastLevel(Number.NaN), 'unknown')
})

test('an unparseable colour THROWS instead of being treated as black', () => {
  assert.throws(() => contrastRatio('not-a-color', '#ffffff'), /E_INPUT_FORMAT/u)
  assert.throws(() => contrastRatio('#ffffff', 'rgb(oops)'), /E_INPUT_FORMAT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['atoms/btn-primary/bg-color'],
  bundle: { key: 'atoms', paths: ['atoms/btn-primary/bg-color'], rules: ['token-adherence'] },
  ruleText: '<rules path="atoms/btn-primary/bg-color">\nToken 一致性：硬编码值应替换为既有 token。\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', layerId: 'btn-primary', prop: 'bg-color', tokenName: 'brand-primary', path: 'atoms/btn-primary/bg-color', evidence: '属性 bg-color = #2563eb', message: '硬编码了品牌主色', defended: true },
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
  assert.doesNotMatch(P6.system, /本轮负责的组件/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /Token 一致性/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /100/u, 'P4 must state the tool bound')
  assert.doesNotMatch(P6.system, /Token 一致性：硬编码值应替换为既有 token。/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts repeat the anchor law, and P4 forbids qualitative contrast claims', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /锚点/u)
  }
  assert.match(P4.system, /不要输出行号/u)
  assert.match(P4.system, /token 名/u)
  assert.match(P4.system, /对比度必须是算出来的数字/u)
  assert.match(P4.system, /4\.5:1/u)
  assert.match(P6.system, /token 存在吗/u)
  assert.match(P6.system, /没有数字就没有结论/u)
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

const EV_TOKENS = {
  color: { 'brand-primary': { value: '#2563eb' }, surface: { value: '#ffffff' } },
  radius: { md: { value: '8px' } },
}
const EV_LAYERS = [
  { id: 'btn', props: { 'bg-color': '#2563eb', radius: '8px' }, tokenRefs: { radius: 'md' } },
]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('resolve_token finds the token carrying an exact value, and reports how many it scanned', async () => {
  const tool = toolByName('resolve_token')
  const result = await tool.execute({ value: '#2563eb', tokens: EV_TOKENS }, {})
  assert.deepEqual(result.items, [{ group: 'color', name: 'brand-primary', value: '#2563eb' }])
  assert.equal(result.truncated, false)
  assert.match(result.provenance, /逐字比较/u)
})

await testAsync('resolve_token is honest when no token carries the value', async () => {
  const tool = toolByName('resolve_token')
  const result = await tool.execute({ value: '#123456', tokens: EV_TOKENS }, {})
  assert.deepEqual(result.items, [])
  assert.match(result.notes[0], /就近取一个/u)
})

await testAsync('resolve_token caps its hit count and reports the cap', async () => {
  const tool = toolByName('resolve_token')
  const many = { color: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`c${index}`, { value: '#2563eb' }])) }
  const result = await tool.execute({ value: '#2563eb', tokens: many }, {})
  assert.equal(result.items.length, tool.limits.maxItems)
  assert.equal(result.truncated, true)
})

await testAsync('contrast_ratio returns the SAME number the anchor computes, plus the threshold', async () => {
  const tool = toolByName('contrast_ratio')
  const result = await tool.execute({ foreground: '#767676', background: '#ffffff' }, {})
  assert.equal(result.items.length, 1)
  assert.equal(typeof result.items[0].ratio, 'number', 'the ratio must be a number, not a qualitative string')
  assert.equal(result.items[0].ratio, contrastRatio('#767676', '#ffffff'))
  assert.equal(result.items[0].level, 'AA')
  assert.equal(result.items[0].threshold, 4.5)
  assert.equal(result.truncated, false)
  assert.match(result.provenance, /保留两位小数/u)
})

await testAsync('contrast_ratio refuses an unparseable colour instead of guessing', async () => {
  const tool = toolByName('contrast_ratio')
  assert.throws(() => tool.execute({ foreground: 'blurple', background: '#ffffff' }, {}), /无法解析前景色/u)
  assert.throws(() => tool.execute({ foreground: '#ffffff', background: 'blurple' }, {}), /无法解析背景色/u)
})

await testAsync('list_layer_props separates token refs from hardcoded values', async () => {
  const tool = toolByName('list_layer_props')
  const result = await tool.execute({ layerId: 'btn', layers: EV_LAYERS, tokens: EV_TOKENS }, {})
  const byProp = Object.fromEntries(result.items.map((item) => [item.prop, item]))
  assert.equal(byProp['bg-color'].kind, 'hardcoded')
  assert.equal(byProp['bg-color'].suggestedToken, 'color.brand-primary')
  assert.equal(byProp.radius.kind, 'token-ref')
  assert.equal(byProp.radius.tokenRef, 'md')
})

await testAsync('list_layer_props flags a broken token reference', async () => {
  const tool = toolByName('list_layer_props')
  const result = await tool.execute({
    layerId: 'bad',
    layers: [{ id: 'bad', props: { 'bg-color': '#2563eb' }, tokenRefs: { 'bg-color': 'brand-secondary' } }],
    tokens: EV_TOKENS,
  }, {})
  assert.match(result.notes[0], /坏引用/u)
})

await testAsync('a request naming an absent layer fails loudly with the available layers', async () => {
  const tool = toolByName('list_layer_props')
  assert.throws(() => tool.execute({ layerId: 'nope', layers: EV_LAYERS }, {}), /图层表里没有 "nope"/u)
})

await testAsync('a request with no token table is refused, not answered with "nothing found"', async () => {
  const tool = toolByName('resolve_token')
  assert.throws(() => tool.execute({ value: '#2563eb' }, {}), /缺少 `tokens`/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('ui-visual', 'contrast_ratio'), 'adjudicate_ui_visual_evidence_contrast_ratio')
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
                layerId: 'btn-primary',
                prop: 'bg-color',
                tokenName: 'brand-primary',
                path: 'atoms/btn-primary/bg-color',
                evidence: '属性 bg-color = #2563eb',
                message: '硬编码了品牌主色',
                severity: 'medium',
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
  assert.match(requests[0].prompt[0].text, /UI 视觉设计/u, 'the domain prompt must be the one sent')
  assert.match(requests[0].prompt[0].text, /对比度必须是算出来的数字/u, 'the computable-contrast law must survive into the child prompt')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('precision-first drops what it cannot prove and keeps what it can', () => {
  const panel = runCritiquePanel([
    { id: 'proven', path: 'atoms/btn-primary/bg-color', start: 3, severity: 'high', evidence: '属性 bg-color = #2563eb', defended: true },
    { id: 'bare', path: 'atoms/btn-primary/radius', start: 4, severity: 'low', evidence: '' },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['proven'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['bare'])
  assert.equal(panel.kind, 'fact-checker')
})

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(8, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 8)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, 0.25)
  assert.equal(proof.complete, false)
})

test('an unanchored finding is excluded from the effective findings AND from coverage', () => {
  const findings = [
    { id: 'a1', path: 'atoms/btn-primary/bg-color', start: 3, severity: 'high', evidence: 'x', defended: true },
    { id: 'a2', path: 'molecules/card-body/text-color', severity: 'high', evidence: 'y', defended: true },
  ]
  const anchored = findings.filter((finding) => typeof finding.start === 'number' && finding.start > 0)
  assert.equal(anchored.length, 1)
  const proof = coverage(8, anchored)
  assert.equal(proof.reviewed, 1)
  assert.equal(proof.coverageRate, 0.125, 'the unanchored path must not be counted as reviewed')
})

test('the report carries the domain, the orientation and the criticism kind', () => {
  const panel = runCritiquePanel([
    { id: 'f', path: 'atoms/btn-primary/bg-color', start: 3, severity: 'high', evidence: 'x', defended: true },
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
  assert.equal(built.domain, 'ui-visual')
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
  const loaded = await loadDomain(io, { id: 'ui-visual', dir: 'domains/ui-visual' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'layers-and-tokens')
  assert.equal(assembled.anchorVerifier.kind, 'layer-and-token')
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
  const mine = result.packs.find((item) => item.id === 'ui-visual')
  assert.ok(mine !== undefined, `ui-visual must load; problems: ${JSON.stringify(result.problems)}`)
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
    domain: 'ui-visual',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload: happy.input.payload },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'layers-and-tokens')
  assert.equal(plan.candidateSet.inputFormat, 'design-tokens-and-layers')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.strategy, 'component')
  assert.equal(plan.bundleKey.derived, plan.gate.admitted)
  assert.equal(plan.bundles.length, 3, 'a three-component design must form three bundles')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), happy.expect.bundleKeys)
  const atoms = plan.bundles.find((item) => item.key === 'atoms')
  assert.ok(atoms !== undefined, 'the atoms component must form its own bundle')
  assert.equal(atoms.paths.length, 3, 'all three hardcoded atoms properties must be judged together')
  assert.equal(new Set(atoms.paths).size, 3)
  assert.equal(plan.criticism.kind, 'fact-checker')
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const empty = fixture('empty')
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ui-visual',
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
    domain: 'ui-visual',
    target: 'fixture all-gated-out',
    input: { format: gated.input.format, payload: gated.input.payload },
  }, {})

  assert.equal(plan.gate.admitted, 0)
  const predicates = Object.fromEntries(plan.gate.excluded.map((item) => [item.path, item.predicate]))
  assert.deepEqual(predicates, {
    'atoms/huge-export/radius': 'too-large',
    'atoms/old-card/bg-color': 'deleted',
    'atoms/raster-hero/bg-color': 'binary',
    'deprecated/legacy-button/bg-color': 'user-exclude',
  })
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /排除 4 项/u)
})

await testAsync('P0 -> P7 round trip: anchors come from the DOMAIN verifier, and the rate follows them', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const payload = happy.input.payload

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ui-visual',
    target: 'fixture happy-path',
    input: { format: happy.input.format, payload },
  }, {})

  const enumerated = source.enumerate(payload, { maxCandidates: 400, maxExcerptLines: 500 })
  const documents = enumerated.candidates.map((candidate) => ({ path: candidate.path, content: candidate.text }))

  const resolvable = enumerated.candidates.filter((candidate) => candidate.meta.tokenName !== null)
  const anchoredFindings = []
  for (const candidate of resolvable.slice(0, 3)) {
    const lines = String(candidate.text).split('\n').filter((line) => line.trim() !== '')
    const excerpt = lines[lines.length - 1]
    const verdict = anchor.verify({
      kind: 'layer-and-token',
      path: candidate.path,
      locator: { layerId: candidate.meta.layerId, prop: candidate.meta.prop, tokenName: candidate.meta.tokenName },
      excerpt,
    }, { path: candidate.path, tokens: payload.tokens, layers: payload.layers, documents })
    assert.equal(verdict.status, 'anchored', `${candidate.id} must anchor through the domain verifier: ${verdict.detail}`)
    assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier))
    anchoredFindings.push({
      id: candidate.id,
      path: verdict.path,
      // CHANGED (t22): `layerId`/`prop`/`tokenName` used to sit at the TOP LEVEL
      // of the finding and never reached the domain verifier — `recomputeAnchor`
      // (index.js:755-762) passes `finding.locator` through VERBATIM and only
      // folds the top-level `start`/`end` convenience fields in when there is no
      // locator at all. The layer/prop/token triple belongs in `locator`.
      locator: { layerId: candidate.meta.layerId, prop: candidate.meta.prop, tokenName: candidate.meta.tokenName },
      severity: 'medium',
      message: `${candidate.meta.layerId}.${candidate.meta.prop} 应使用 token ${candidate.meta.tokenName}`,
      excerpt,
      evidence: excerpt,
      defended: true,
    })
  }
  assert.equal(anchoredFindings.length, 3)

  const paraphrase = anchor.verify({
    kind: 'layer-and-token',
    path: resolvable[0].path,
    locator: { layerId: resolvable[0].meta.layerId, prop: resolvable[0].meta.prop, tokenName: resolvable[0].meta.tokenName },
    excerpt: '这个按钮的颜色大概应该用品牌色 token',
  }, { path: resolvable[0].path, tokens: payload.tokens, layers: payload.layers, documents })
  assert.equal(paraphrase.status, 'unanchored')

  const paraphraseFinding = {
    id: 'f-paraphrase',
    path: resolvable[0].path,
    locator: { layerId: resolvable[0].meta.layerId, prop: resolvable[0].meta.prop, tokenName: resolvable[0].meta.tokenName },
    severity: 'medium',
    message: '转述而非抄写',
    excerpt: '这个按钮的颜色大概应该用品牌色 token',
    evidence: '这个按钮的颜色大概应该用品牌色 token',
  }

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'ui-visual',
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
  // documents}`, it could not carry this domain's layer/token tables, and every
  // finding was refused as `no-documents`.
  //
  // t27 fixed the CAUSE rather than the number. `subject.candidates` — declared
  // by the contract (§1.2) all along and supplied by the engine since t21
  // (index.js:789-803) — is the P0 candidate set, and it IS this domain's
  // locator space. `anchor.js` rebuilds the layer/props table and the token table
  // from it, so the same findings now anchor through the real plugin path. The
  // old pinned 0 was a deliberate tripwire: it went red the moment this landed,
  // and the numbers below are what replaced it.
  // ---------------------------------------------------------------------
  assert.equal(submitted.coverage.reviewed, 3,
    'exactly the three really-anchored findings count — a real number, not an upper bound')
  assert.equal(submitted.coverage.coverageRate, Number((3 / plan.gate.admitted).toFixed(4)))
  assert.equal(submitted.unanchored, 1, 'exactly the paraphrase is unanchored — not "at least one"')
  assert.equal(submitted.anchorVia, 'anchorVerifier',
    'the DOMAIN verifier is the path that ran, and it anchored — the tables were rebuilt from the candidate set')
  assert.deepEqual(
    submitted.unanchoredDetails.map((item) => ({ id: item.id, tier: item.tier })),
    [{ id: 'f-paraphrase', tier: 'no-match' }],
    'the ONLY rejection is the paraphrase, and it is refused as no-match — a real verdict, not "nothing to check against"',
  )
  assert.equal(submitted.findings.length, 3, 'the three anchored findings survive the fact-checker panel')
  assert.ok(submitted.findings.every((finding) => TRUSTED_ANCHOR_TIERS.includes(finding.anchorTier)),
    `every kept finding must carry a trusted tier (got ${submitted.findings.map((f) => f.anchorTier).join(', ')})`)

  // The rebuilt tables are not a rubber stamp: see the dedicated test below.
  assert.equal(anchoredFindings.length, 3)
  assert.ok(!submitted.findings.some((finding) => finding.id === 'f-paraphrase'), 'an unanchored finding is not an effective finding')
  assert.equal(submitted.criticismKind, 'fact-checker')
})

await testAsync('P5 through the real adjudication_anchor: the tables are rebuilt from the P0 candidate set', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const payload = happy.input.payload

  // A real plan first: it is what registers the admitted candidate set the
  // engine hands the verifier (index.js:954, 1286-1289).
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ui-visual',
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
  const target = enumerated.candidates.find((candidate) => candidate.meta.layerId === 'btn-primary' && candidate.meta.prop === 'bg-color')
  assert.ok(target !== undefined, 'the fixture must contain btn-primary.bg-color')

  const claimFor = (locator, excerpt = excerptOf(target)) => ({
    domain: 'ui-visual',
    path: target.path,
    // ONLY the domain locator. There is no way to pass `layers`/`tokens` through
    // the plugin, so if the verifier cannot rebuild them this can never anchor.
    locator,
    excerpt,
    documents,
  })
  const realLocator = { layerId: 'btn-primary', prop: 'bg-color', tokenName: 'brand-primary' }

  const anchored = await ctx.__tools.get('adjudication_anchor').execute(claimFor(realLocator), {})
  assert.equal(anchored.via, 'anchorVerifier', 'the domain verifier is the path that ran')
  assert.equal(anchored.status, 'anchored', anchored.detail)
  assert.ok(TRUSTED_ANCHOR_TIERS.includes(anchored.tier), `tier "${anchored.tier}" must be trusted`)
  assert.equal(anchored.path, target.path)
  assert.equal(anchored.token, 'brand-primary')
  assert.match(anchored.detail, /P0 候选集重建/u, 'the verdict must say where the layer/token tables came from')

  // --- REBUILD IS A CHECK, NOT A RUBBER STAMP -----------------------------

  // A layer that is in no candidate.
  const unknownLayer = await ctx.__tools.get('adjudication_anchor').execute(
    claimFor({ ...realLocator, layerId: 'not-a-layer' }), {})
  assert.equal(unknownLayer.status, 'unanchored')
  assert.equal(unknownLayer.tier, 'no-match', 'a layer outside the candidate locator space must be refused')

  // A property the candidate set never enumerated for that layer. `btn-primary`
  // exists; `shadow` is not one of its candidates.
  const unknownProp = await ctx.__tools.get('adjudication_anchor').execute(
    claimFor({ layerId: 'btn-primary', prop: 'shadow', tokenName: 'brand-primary' }), {})
  assert.equal(unknownProp.status, 'unanchored')
  assert.equal(unknownProp.tier, 'no-match', 'the rebuilt prop table only holds the properties that became candidates')

  // A token name no candidate resolved to. The claim's own token table check is
  // what refuses it — this is the domain's central "never cite a token that does
  // not exist" rule, now reachable in production.
  const unknownToken = await ctx.__tools.get('adjudication_anchor').execute(
    claimFor({ layerId: 'btn-primary', prop: 'bg-color', tokenName: 'not-a-token' }), {})
  assert.equal(unknownToken.status, 'unanchored')
  assert.equal(unknownToken.tier, 'no-match', 'a token absent from the rebuilt token table must be refused')

  // --- NO BYPASS: nothing to rebuild => still no-documents -----------------

  // An EMPTY candidate set is a candidate set that establishes nothing. It must
  // not degrade into "fine, then".
  const emptySet = await ctx.__tools.get('adjudication_anchor').execute(
    { ...claimFor(realLocator), candidates: [] }, {})
  assert.equal(emptySet.status, 'unanchored')
  assert.equal(emptySet.tier, 'no-documents', 'an empty candidate set rebuilds nothing and must still refuse')

  // A candidate set whose entries carry no (layer, property) locator at all.
  const uselessSet = await ctx.__tools.get('adjudication_anchor').execute({
    ...claimFor(realLocator),
    candidates: [{ id: 'x', path: 'whatever', locator: {}, text: '' }],
  }, {})
  assert.equal(uselessSet.status, 'unanchored')
  assert.equal(uselessSet.tier, 'no-documents', 'candidates without a layer/prop locator establish no structure')
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'ui-visual' }, {})
  const listed = await ctx.__tools.get('adjudicate_ui_visual_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'ui-visual' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName('ui-visual', tool.name)), `${tool.name} must be registered on activation`)
  }
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'ui-visual' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('ui-visual', tool.name)), false)
  }
})

await testAsync('the registered contrast tool returns a real ratio end to end through the plugin', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'ui-visual' }, {})
  const tool = ctx.__tools.get(evidenceToolName('ui-visual', 'contrast_ratio'))
  const result = await tool.execute({ foreground: '#767676', background: '#ffffff' }, {})
  assert.equal(result.domain, 'ui-visual')
  assert.equal(result.items[0].ratio, 4.54)
  assert.equal(result.items[0].level, 'AA')
  assert.match(result.summary, /出处/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ui-visual',
    target: 'replacement probe',
    candidates: [
      { path: 'atoms/btn/bg-color' },
      { path: 'atoms/btn/radius' },
      { path: 'molecules/card/bg-color' },
      { path: 'molecules/card/radius' },
    ],
  }, {})
  // v1 declared the string 'component'; v2 declares the object form with
  // `resolve`. The object form always applies — that is the migration.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'component')
  assert.equal(plan.bundleKey.derived, 4)
  assert.equal(plan.bundles.length, 2)
  const atoms = plan.bundles.find((item) => item.key === 'atoms')
  assert.ok(atoms !== undefined, 'the two candidates of one component must share one bundle')
  assert.deepEqual(atoms.paths.sort(), ['atoms/btn/bg-color', 'atoms/btn/radius'])
  assert.notEqual(
    resolveBundleKey(pack, { path: 'atoms/btn/bg-color' }, {}).key,
    resolveBundleKey(pack, { path: 'molecules/card/bg-color' }, {}).key,
    'two different components must NOT collide',
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
