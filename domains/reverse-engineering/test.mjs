/**
 * reverse-engineering — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  one candidate per artifact / statement / repro
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey                  ->  one bundle per LEAD
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  sample + reproduction-state recomputation
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 * ------------------------------------
 * 1. It never asserts a status without asserting the tier AND the domain code.
 *    "anchored" alone is satisfiable by a verifier that guesses; the tier says it
 *    did not, and `code` says whether the SAMPLE and the reproduction level were
 *    confirmed, or only the text.
 * 2. It never lets P4 and P6 share a prompt (the validators do not check it).
 * 3. It never hands `adjudication_submit` an anchor it made up. Two of the
 *    round-trip findings are deliberately dishonest — one presents a steps=0
 *    inference as verified, one cites a different sample hash — and the ENGINE is
 *    what refuses them. A test that only submitted honest anchors could not tell
 *    "recomputed" from "believed".
 *
 * Usage: `node domains/reverse-engineering/test.mjs`
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
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_GATE_PREDICATES,
  bundle,
  coverage,
  createBudget,
  gate,
  report,
  runCritiquePanel,
  selectRules,
} from '../../lib/engine.js'
import { createNodeIo, loadDomain } from '../../lib/domain-loader.js'
import { apply as applyPlugin } from '../../index.js'

import pack from './index.js'
import source, { isReproduced, leadKeyFromPath, leadsOf, renderNote } from './source.js'
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
  const value = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
  FIXTURES.set(value.name, value)
}

const fixture = (name) => {
  const value = FIXTURES.get(name)
  assert.ok(value !== undefined, `missing fixture "${name}"`)
  return value
}

const RULE_FILES = readdirSync(join(here, 'rules')).filter((file) => file.endsWith('.md')).sort()

// CHANGED (t33/t24): the fixture is no longer allowed to narrow the gate. It
// used to contribute `exclude` patterns and a `maxFileBytes`, which meant the
// `all-gated-out` boundary was reached by a rule the PACK does not declare (and
// `adjudication_plan` has no `gate` input at all, so the narrowing never
// reached the plugin). Every fixture here now carries NO `gate` block —
// asserted in the scan section below — and the boundary is asserted through the
// REAL plan where only the pack's own gate exists.
function runP0P1(name) {
  const value = fixture(name)
  const enumerated = source.enumerate(value.input.payload, { maxCandidates: 400, maxExcerptLines: 500 })
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
    if (!map[item.predicate]) map[item.predicate] = new Set()
    map[item.predicate].add(item.path)
  }
  const out = {}
  for (const [key, paths] of Object.entries(map)) out[key] = [...paths].sort()
  return out
}

function keyedAdmitted(name) {
  const { result } = runP0P1(name)
  return result.selected.map((entry) => {
    const resolution = resolveBundleKey(pack, entry, {})
    return resolution.applied ? { ...entry, key: resolution.key } : entry
  })
}

/**
 * The documents a reviewer hands back: one note per lead (rendered by the very
 * function the verifier's registry describes) plus the sample REGISTRY under the
 * domain convention (`re/<…>.json`). The engine's recompute path can only pass a
 * verifier `{path, content, document, documents}`, so the registry travels as a
 * document — the sample checked is the one the plan was given.
 */
function documentsFor(name) {
  const payload = fixture(name).input.payload
  const observations = payload.observations
  const documents = leadsOf(observations).map((lead) => ({
    path: `re/${String(payload.artifact.id).toLowerCase()}/observations/${String(lead).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')}.md`,
    content: renderNote(payload.artifact, lead, observations.filter((observation) => (observation.lead ?? 'general') === lead)),
  }))
  documents.push({
    path: `re/${String(payload.artifact.id).toLowerCase()}.json`,
    content: JSON.stringify({ artifact: payload.artifact, observations }),
  })
  return documents
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\nreverse-engineering domain — contract v2 end-to-end')
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
      rules: RULE_FILES.map((file, index) => ({ name: `rule-${index}`, match: ['**/*'], text: 'y'.repeat(12), needsExpertReview: true })),
    },
    fixtures: FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')),
  })
  assert.deepEqual(problems, [], problems.join('; '))
})

test('the declared input format matches the contract table for this domain', () => {
  const declared = inputFormatFor('reverse-engineering')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(declared.bounded, false)
  assert.equal(source.bounded, false)
  assert.equal(pack.candidateSet.bounded, false)
})

test('this is a C domain: it declares unbounded candidates, and the contract agrees', () => {
  assert.equal(pack.category, 'C')
  assert.equal(pack.candidateSet.bounded, false)
  assert.deepEqual(checkContractIntegrity(), [])
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable')
})

test('criticism.kind agrees with the loss orientation', () => {
  assert.equal(pack.lossOrientation, 'recall-first')
  assert.equal(pack.criticism.kind, 'triage')
})

test('evidence.js defines a bounded toolkit the contract accepts', () => {
  assert.deepEqual(validateEvidenceToolkit(evidence), [])
  assert.ok(evidence.tools.length > 0)
  for (const tool of evidence.tools) {
    assert.ok(tool.limits.maxLines > 0 && tool.limits.maxItems > 0 && tool.limits.maxCalls > 0, `${tool.name} must declare positive limits`)
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

test('every rule states a failure mode, an evidence duty and a "不算" boundary', () => {
  for (const file of RULE_FILES) {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    assert.match(text, /失败模式/u, `${file} must name the concrete failure mode`)
    assert.match(text, /取证义务/u, `${file} must state what evidence the reviewer owes`)
    assert.match(text, /不算/u, `${file} must state what does NOT count`)
  }
})

test('every rule is live for this domain\'s real candidate paths (no dead rule)', () => {
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = /^name:\s*(.+)$/mu.exec(text)?.[1]?.trim()
    const match = [...text.matchAll(/^\s+-\s+"(.+)"$/gmu)].map((hit) => hit[1])
    return { name, match, text: 'z'.repeat(20) }
  })
  const { result } = runP0P1('happy-path')
  const paths = [...new Set(result.selected.map((entry) => entry.path))]
  const injected = new Set(selectRules(rules, paths).injected.map((rule) => rule.name))
  for (const rule of rules) {
    assert.ok(injected.has(rule.name), `rule "${rule.name}" matches none of ${paths.join(', ')} — it would never fire`)
  }
})

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'only-pcap', match: ['**/*.pcap'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['re/fw-1.2.3/observations/auth-flow.md'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  assert.ok(FIXTURES.has('unverified-observation'))
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

console.log('\nP0/P1 — empty / all-gated-out / admitted')

test('boundary: an empty observation set produces an EMPTY candidate set, and an empty gate', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  const expected = fixture('empty').expect
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path), expected.paths)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
})

test('the honest cost model survives the EMPTY run — the run that would otherwise look complete', () => {
  const { enumerated } = runP0P1('empty')
  for (const fragment of fixture('empty').expect.noteFragments) {
    assert.ok(enumerated.notes.some((note) => note.includes(fragment)), `empty-run notes must keep "${fragment}"`)
  }
  assert.equal(enumerated.bounded, false)
})

test('boundary: all-gated-out enumerates candidates and the gate removes EVERY one', () => {
  const expected = fixture('all-gated-out').expect
  const { enumerated, result } = runP0P1('all-gated-out')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted, 'the gate must admit nothing here')
  assert.equal(result.excluded.length, expected.candidates)
  const predicates = byPredicate(result)
  for (const [predicate, paths] of Object.entries(expected.excludedByPredicate)) {
    assert.deepEqual(predicates[predicate] ?? [], [...paths].sort(), `predicate "${predicate}" mismatch`)
  }
  assert.deepEqual(Object.keys(predicates).sort(), Object.keys(expected.excludedByPredicate).sort(), 'no unexpected predicate fired')
})

test('boundary: an empty seed and a fully-excluded seed are distinguishable in the plan', () => {
  const empty = runP0P1('empty')
  const gatedOut = runP0P1('all-gated-out')
  assert.equal(empty.enumerated.candidates.length, 0)
  assert.equal(empty.result.excluded.length, 0)
  assert.equal(empty.result.selected.length, 0)
  // CHANGED (t33/t24): the weak form ("something was excluded") is gone — the
  // count is exact and every exclusion is pinned to the predicate that fired.
  assert.equal(gatedOut.enumerated.candidates.length, fixture('all-gated-out').expect.candidates)
  assert.equal(gatedOut.result.selected.length, 0, 'all-gated-out: P1 admitted NOTHING')
  assert.equal(gatedOut.result.excluded.length, fixture('all-gated-out').expect.candidates)
  assert.deepEqual(byPredicate(gatedOut.result), fixture('all-gated-out').expect.excludedByPredicate)
  assert.deepEqual(Object.keys(byPredicate(gatedOut.result)).sort(), ['binary', 'default-path', 'deleted', 'extension', 'user-exclude'],
    'five different predicates must do the excluding, not one blanket rule')
})

test('boundary: a statement with no text is EXCLUDED BY THE SOURCE, not silently kept', () => {
  const expected = fixture('all-gated-out').expect
  const { enumerated } = runP0P1('all-gated-out')
  assert.equal(enumerated.excluded.length, expected.sourceExcluded)
  assert.equal(enumerated.excluded[0].id, 'o-blank')
  assert.match(enumerated.excluded[0].reason, /没有 statement 正文/u)
})

test('happy path: one candidate per artifact / statement / repro line; all admitted', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.id), expected.candidateIds)
})

test('the reproduction status is enumerated, and steps=0 is NOT "steps not needed"', () => {
  const expected = fixture('happy-path').expect
  const { enumerated } = runP0P1('happy-path')
  for (const [observationId, verified] of Object.entries(expected.verified)) {
    const statement = enumerated.candidates.find((candidate) => candidate.id === `${observationId}#statement`)
    assert.equal(statement.meta.verified, verified, `${observationId} reproduction status`)
    assert.equal(statement.locator.verified, verified)
  }
  // The empty-steps inference and the explicitly-unverified observation are the
  // two shapes that must never be presentable as observations.
  assert.equal(isReproduced({ kind: 'inference', reproducibility: { steps: [] } }), false)
  assert.equal(isReproduced({ kind: 'inference', reproducibility: { steps: ['a'] } }), true)
  assert.equal(isReproduced({ kind: 'observation', verified: false, reproducibility: { steps: ['a'] } }), false)
  assert.match(
    enumerated.candidates.find((candidate) => candidate.id === 'o-crypto-guess#repro').text,
    /steps=0 verified=false \(推断，未复现\)/u,
  )
})

test('the unverified fixture reports its missing steps instead of hiding them', () => {
  const { enumerated } = runP0P1('unverified-observation')
  for (const fragment of fixture('unverified-observation').expect.noteFragments) {
    assert.ok(enumerated.notes.some((note) => note.includes(fragment)), `notes must include "${fragment}"`)
  }
  assert.equal(enumerated.candidates.length, 5)
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ observations: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ artifact: { id: 'x' }, observations: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ artifact: { id: 'x', sha256: 'a' } }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ artifact: { id: 'x', sha256: 'a' }, observations: [] }, {}))
})

test('candidate ids are unique and `path` stays a gate-globable note path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.match(candidate.path, /^[a-z0-9][a-z0-9._:/-]*$/u, 'the gate cannot glob this path')
    assert.match(candidate.path, /^re\/.+\/observations\/.+\.md$/u)
    assert.equal(typeof candidate.locator.artifactId, 'string')
  }
})

test('the candidate text is a real line of the note the verifier will read', () => {
  const payload = fixture('happy-path').input.payload
  const rendered = leadsOf(payload.observations).map((lead) =>
    renderNote(payload.artifact, lead, payload.observations.filter((observation) => (observation.lead ?? 'general') === lead)))
  for (const candidate of source.enumerate(payload, {}).candidates) {
    assert.ok(
      rendered.some((note) => note.includes(candidate.text)),
      `the note must contain "${candidate.text}" verbatim — otherwise every anchor fails by construction`,
    )
  }
})

test('the gate is the engine\'s ordered predicate list, and the pack only narrows it', () => {
  assert.deepEqual(gate([], {}).ordered, DEFAULT_GATE_PREDICATES.map(([label]) => label))
  // CHANGED (t33/t24): the old form required every pack pattern to be an engine
  // default, which cannot express a domain-owned exclusion. `**/archive/**` is
  // declared by the pack, and it is what makes the all-gated-out boundary hold
  // without the fixture narrowing anything.
  assert.deepEqual(pack.gate.exclude, ['**/.git/**', '**/dist/**', '**/build/**', '**/archive/**'])
  assert.ok(pack.gate.exclude.includes('**/archive/**'), 'the domain-owned exclusion must live in the pack')
})

test('file-level facts cover the whole note: a deleted observation takes its artifact row with it', () => {
  const { enumerated } = runP0P1('all-gated-out')
  const retracted = enumerated.candidates.filter((candidate) => candidate.path.endsWith('retracted.md'))
  assert.equal(retracted.length, 3)
  assert.ok(retracted.every((candidate) => candidate.deleted === true), 'every candidate of one note shares the file-level flags')
  assert.equal(new Set(retracted.map((candidate) => candidate.bytes)).size, 1)
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling by lead')

test('bundleKey is a v2 object whose private strategy supplies its own resolver', () => {
  const declared = pack.bundleKey
  assert.equal(typeof declared, 'object')
  assert.equal(declared.strategy, 're-lead')
  assert.ok(!['path', 'file', 'directory', 'extension'].includes(declared.strategy), 'a generic strategy cannot express "one lead"')
  assert.equal(typeof declared.resolve, 'function')
  assert.equal(declared.resolve({ path: 're/fw-1.2.3/observations/auth-flow.md' }), 're/fw-1.2.3/observations/auth-flow')
  assert.notEqual(declared.resolve({ path: 're/fw-1.2.3/observations/auth-flow.md' }), 're/fw-1.2.3/observations/auth-flow.md')
  assert.equal(leadKeyFromPath('re/fw-1.2.3/observations/auth-flow.md'), 're/fw-1.2.3/observations/auth-flow')
  assert.equal(leadKeyFromPath('other/thing.md'), 'other/thing.md', 'a foreign path must not become an invented lead')
})

test('a hypothesis and the observations of its lead land in ONE bundle', () => {
  const expected = fixture('happy-path').expect
  const keyed = keyedAdmitted('happy-path')
  assert.ok(keyed.length >= 4, 'bundle() short-circuits below 4 entries; this fixture must be past that')

  const bundled = bundle(keyed)
  assert.deepEqual(bundled.bundles.map((item) => item.key).sort(), expected.bundleKeys)
  assert.equal(bundled.bundles.length, expected.bundles)
  assert.equal(bundled.degraded, false)

  const byKey = new Map(bundled.bundles.map((item) => [item.key, item.entries]))
  for (const [left, right] of expected.sameBundle) {
    const owner = [...byKey.entries()].find(([, entries]) => entries.some((entry) => entry.id === left))
    assert.ok(owner !== undefined, `${left} must be in some bundle`)
    assert.ok(owner[1].some((entry) => entry.id === right), `${left} and ${right} must share one bundle (got ${owner[0]})`)
  }
  for (const [key, size] of Object.entries(expected.bundleSizes)) {
    assert.equal(byKey.get(key)?.length, size, `bundle ${key} size`)
  }

  // The counterfactual the acceptance warns about: one bundle per CANDIDATE.
  const naive = bundle(keyed.map((entry) => ({ ...entry, key: entry.id })))
  assert.equal(naive.bundles.length, keyed.length)
  assert.ok(bundled.bundles.length < naive.bundles.length)
})

test('resolveBundleKey reports the resolver as applied/derived for every candidate', () => {
  const { result } = runP0P1('happy-path')
  for (const entry of result.selected) {
    const resolution = resolveBundleKey(pack, entry, {})
    assert.equal(resolution.applied, true)
    assert.equal(resolution.source, 'derived')
    assert.equal(resolution.strategy, 're-lead')
  }
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
      assert.equal(verdict.status, 'anchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      if (entry.expectCode !== undefined) assert.equal(verdict.code, entry.expectCode, entry.note)
      if (entry.expectPath !== undefined) assert.equal(verdict.path, entry.expectPath)
      if (entry.expectStart !== undefined) assert.equal(verdict.start, entry.expectStart)
      assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier), `tier "${verdict.tier}" is not trusted`)
      assert.equal(typeof verdict.detail, 'string')
    })
  }
  for (const entry of value.anchors.negative ?? []) {
    test(`anchor negative [${name}] -> ${entry.expectTier}/${entry.expectCode ?? '?'}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, 'unanchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      if (entry.expectCode !== undefined) assert.equal(verdict.code, entry.expectCode, entry.note)
      assert.equal(verdict.start, null, 'an unanchored verdict must not carry a line number')
      assert.equal(verdict.path, null)
      if (entry.expectKnownObservations !== undefined) assert.deepEqual(verdict.knownObservations, entry.expectKnownObservations)
    })
  }
  for (const entry of value.anchors.ambiguous ?? []) {
    test(`anchor ambiguous [${name}] -> ${entry.expectTier}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, 'unanchored', entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      assert.ok(Array.isArray(verdict.ambiguousIn) && verdict.ambiguousIn.length > 1)
      if (entry.expectAmbiguousIn !== undefined) assert.deepEqual(verdict.ambiguousIn, entry.expectAmbiguousIn)
    })
  }
}

test('a paraphrase never anchors, even when every offset in it is right', () => {
  const verdict = anchor.verify(
    { kind: 'reproducible-observation', path: 're/fw-1.2.3/observations/auth-flow.md', locator: { artifactId: 'fw-1.2.3', kind: 'statement', observationId: 'o-uart-shell' }, excerpt: 'statement o-uart-shell :: The firmware exposes an unauthenticated UART shell.' },
    {
      path: 're/fw-1.2.3/observations/auth-flow.md',
      content: 'statement o-uart-shell :: The firmware exposes a UART shell on pin 12 without authentication.\n',
      artifact: { id: 'fw-1.2.3', sha256: 'a'.repeat(64) },
      observations: [{ id: 'o-uart-shell', kind: 'observation', verified: true, reproducibility: { steps: ['x'] } }],
    },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('the sample check runs BEFORE the text check: a perfect quotation from another build is refused', () => {
  const verdict = anchor.verify(
    { kind: 'reproducible-observation', path: 're/fw-1.2.3/observations/auth-flow.md', locator: { artifactId: 'fw-1.2.3', sha256: 'b'.repeat(64), kind: 'statement', observationId: 'o-uart-shell' }, excerpt: 'statement o-uart-shell :: The firmware exposes a UART shell on pin 12 without authentication.' },
    {
      path: 're/fw-1.2.3/observations/auth-flow.md',
      content: 'statement o-uart-shell :: The firmware exposes a UART shell on pin 12 without authentication.\n',
      artifact: { id: 'fw-1.2.3', sha256: 'a'.repeat(64) },
      observations: [{ id: 'o-uart-shell', kind: 'observation', verified: true, reproducibility: { steps: ['x'] } }],
    },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.code, 'artifact-mismatch', 'the quotation exists — that must not be enough')
  assert.match(verdict.detail, /偏移/u)
})

test('an unreproduced inference can never be verified, however it is worded', () => {
  const verdict = anchor.verify(
    { kind: 'reproducible-observation', path: 're/x/observations/l.md', locator: { artifactId: 'x', kind: 'statement', observationId: 'o-guess', verified: true }, excerpt: 'statement o-guess :: The blob is probably AES-128-CBC.' },
    {
      path: 're/x/observations/l.md',
      content: 'statement o-guess :: The blob is probably AES-128-CBC.\n',
      artifact: { id: 'x', sha256: 'c'.repeat(64) },
      observations: [{ id: 'o-guess', kind: 'inference', reproducibility: { steps: [] } }],
    },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.code, 'verification-overclaim')
  assert.match(verdict.detail, /仍是猜想/u)
})

test('without the sample registry the verifier refuses rather than falling back to text', () => {
  const verdict = anchor.verify(
    { kind: 'reproducible-observation', path: 're/x/observations/l.md', locator: { artifactId: 'x', kind: 'statement', observationId: 'o1' }, excerpt: 'statement o1 :: x' },
    { path: 're/x/observations/l.md', content: 'statement o1 :: x\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-documents')
  assert.equal(verdict.code, 'no-artifact')
})

test('a structured registry document is DATA, not prose: an excerpt never relocates into it', () => {
  const verdict = anchor.verify(
    { kind: 'reproducible-observation', path: 're/x/observations/l.md', locator: { artifactId: 'x', kind: 'statement', observationId: 'o1' }, excerpt: 'statement o1 :: x' },
    {
      path: 're/x/observations/l.md',
      documents: [{ path: 're/x.json', content: JSON.stringify({ artifact: { id: 'x', sha256: 'c'.repeat(64) }, observations: [{ id: 'o1', reproducibility: { steps: ['a'] } }] }) }],
    },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'reproducible-observation', path: 'a', locator: 7 }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['re/fw-1.2.3/observations/auth-flow.md'],
  bundle: { key: 're/fw-1.2.3/observations/auth-flow', paths: ['re/fw-1.2.3/observations/auth-flow.md'], rules: ['inference-as-observation'] },
  ruleText: '<rules path="re/fw-1.2.3/observations/auth-flow.md">\n推断当成观察：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', path: 're/fw-1.2.3/observations/auth-flow.md', sha256: 'a'.repeat(64), verified: false, evidence: 'statement o-crypto-guess :: The configuration blob is probably AES-128-CBC with a fixed IV.', message: '推断被写成观察', defended: true },
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
  assert.doesNotMatch(P6.system, /本轮负责的线索/u, 'P6 must not receive the P4 work order')
  assert.match(P6.system, /反方义务/u)
  assert.match(P6.system, /看不到/u)
})

test('P4 carries the rules and the budget, P6 carries neither', () => {
  assert.match(P4.system, /推断当成观察/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /推断当成观察/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('BOTH prompts state the unbounded cost model, the sample law and the reproducibility law', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /候选集不可先验枚举、成本无上界/u, 'the cost model must reach the model, in both roles')
    assert.match(text, /sha256/u, 'the sample law must be stated')
    assert.match(text, /推断/u)
    assert.match(text, /猜想/u)
    assert.match(text, /未验证/u)
    assert.match(text, /行号/u, 'the no-line-numbers law must be stated')
  }
  assert.match(P4.system, /观察与推断必须分开/u)
  assert.match(P6.system, /复现状态保留了吗/u)
})

test('both prompts refuse to make legal calls', () => {
  assert.match(P4.system, /不得自行断言合法性/u)
  assert.match(P6.system, /不做法律判断/u)
})

test('the recall-first loss sentence is the one rendered, and it is not the precision-first one', () => {
  assert.match(P4.system, /recall-first/u)
  const precision = prompts.review({ ...reviewContext, orientation: 'precision-first' })
  assert.notEqual(precision.system, P4.system)
  assert.match(precision.system, /precision-first/u)
})

test('an empty finding set is described as a legal outcome, not a failure', () => {
  const empty = prompts.verify({ pack, orientation: pack.lossOrientation, findings: [] })
  assert.match(empty.system, /空集不是失败/u)
  assert.match(empty.system, /不代表这个产物没有问题/u)
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const REGISTRY = {
  artifact: { id: 'fw-1.2.3', sha256: 'a'.repeat(64) },
  observations: [
    { id: 'o-uart-shell', kind: 'observation', lead: 'auth-flow', verified: true, reproducibility: { steps: ['a', 'b', 'c'] } },
    { id: 'o-crypto-guess', kind: 'inference', lead: 'auth-flow', reproducibility: { steps: [] } },
  ],
}
const NOTES = [{ path: 're/fw-1.2.3/observations/auth-flow.md', content: '# lead auth-flow\nstatement o-uart-shell :: The firmware exposes a UART shell on pin 12 without authentication.\nrepro o-uart-shell :: steps=3 verified=true\nrepro o-crypto-guess :: steps=0 verified=false (推断，未复现)\n' }]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('note_excerpt reads at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('note_excerpt')
  const big = { path: 're/x/observations/big.md', content: Array.from({ length: 400 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 're/x/observations/big.md', documents: [big] }, {})
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.ok(result.provenance.includes('re/x/observations/big.md'))
})

await testAsync('note_excerpt refuses a note it was not given instead of returning an empty result', async () => {
  const tool = toolByName('note_excerpt')
  assert.throws(() => tool.execute({ path: 're/x/observations/missing.md', documents: NOTES }, {}), /没有 "/u)
  assert.throws(() => tool.execute({ path: 're/fw-1.2.3/observations/auth-flow.md' }, {}), /缺少 `documents`/u)
})

await testAsync('reproduction_check lists who has steps and who does not', async () => {
  const tool = toolByName('reproduction_check')
  const result = await tool.execute({ registry: REGISTRY }, {})
  assert.deepEqual(result.items.map((item) => `${item.observationId}:${item.steps}:${item.reproduced}`), ['o-uart-shell:3:true', 'o-crypto-guess:0:false'])
  assert.match(result.notes.join(' '), /1 条没有可复现步骤/u)
  assert.match(result.notes.join(' '), /必须保留猜想标注）：o-crypto-guess/u)
  assert.match(result.provenance, /不执行步骤/u)
})

await testAsync('reproduction_check accepts the registry as a convention document and refuses when it is absent', async () => {
  const tool = toolByName('reproduction_check')
  const viaDocument = await tool.execute({ documents: [{ path: 're/fw-1.2.3.json', content: JSON.stringify(REGISTRY) }] }, {})
  assert.equal(viaDocument.items.length, 2)
  assert.throws(() => tool.execute({ documents: NOTES }, {}), /缺少 `registry`/u)
  assert.throws(() => tool.execute({ documents: [{ path: 're/fw-1.2.3.json', content: '{oops' }] }, {}), /不是合法 JSON/u)
})

await testAsync('sample_identity compares hashes and refuses when the sample has none', async () => {
  const tool = toolByName('sample_identity')
  const same = await tool.execute({ sha256: 'a'.repeat(64), registry: REGISTRY }, {})
  assert.equal(same.items[0].same, true)
  assert.match(same.notes.join(' '), /样本一致/u)
  const other = await tool.execute({ sha256: 'b'.repeat(64), registry: REGISTRY }, {})
  assert.equal(other.items[0].same, false)
  assert.match(other.notes.join(' '), /不能搬运/u)
  assert.throws(() => tool.execute({ sha256: 'a'.repeat(64), registry: { artifact: { id: 'x' }, observations: [] } }, {}), /没有 sha256/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('reverse-engineering', 'reproduction_check'), 'adjudicate_reverse_engineering_evidence_reproduction_check')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(14, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 14)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, Number((2 / 14).toFixed(4)))
  assert.equal(proof.complete, false)
})

test('triage keeps what it cannot disprove and drops only what is disproved', () => {
  const panel = runCritiquePanel([
    { id: 'suspicion', path: 're/x/observations/a.md', severity: 'low', evidence: '' },
    { id: 'refuted', path: 're/x/observations/b.md', severity: 'high', evidence: 'x', defended: true, disproved: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['suspicion'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['refuted'])
  assert.equal(panel.kind, 'triage')
})

test('the report carries the domain, the orientation, the criticism kind and the recall-first requirement', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 're/x/observations/a.md', severity: 'high', evidence: 'x', defended: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 14, excluded: 0, bundles: 2 },
    findings: panel.kept,
    coverageProof: coverage(14, panel.kept, { requireComplete: true }),
    budget: createBudget({}),
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'reverse-engineering')
  assert.equal(built.lossOrientation, 'recall-first')
  assert.equal(built.criticismKind, 'triage')
  assert.equal(built.coverage.total, 14)
  assert.equal(built.coverage.required, true)
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
  const loaded = await loadDomain(io, { id: 'reverse-engineering', dir: 'domains/reverse-engineering' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'artifact-observations')
  assert.equal(assembled.anchorVerifier.kind, 'reproducible-observation')
  assert.equal(assembled.evidenceTools.tools.length, evidence.tools.length)
  assert.ok(assembled.ruleLibrary.rules.length >= MIN_RULES_PER_DOMAIN)
  assert.deepEqual([...assembled.fixtures].sort(), FIXTURE_FILES.map((file) => file.replace(/\.json$/u, '')).sort())
  for (const field of ['index.js', 'source.js', 'anchor.js', 'evidence.js', 'prompts.js']) {
    assert.ok(loaded.files.includes(field), `loader must report it loaded ${field}`)
  }
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
    effect(callback) {
      const entry = { dispose: undefined, undone: false }
      if (typeof callback === 'function' && callback.constructor?.name === 'GeneratorFunction') {
        const iterator = callback()
        const produced = []
        let step = iterator.next()
        while (step.done !== true) {
          if (typeof step.value === 'function') produced.push(step.value)
          step = iterator.next()
        }
        entry.dispose = () => { for (const disposer of produced) disposer() }
      } else if (typeof callback === 'function') entry.dispose = callback() ?? undefined
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
    inject(_names, callback) { if (typeof callback === 'function') callback(ctx); return () => {} },
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

const planFor = async (ctx, name) => {
  const value = fixture(name)
  return ctx.__tools.get('adjudication_plan').execute({
    domain: 'reverse-engineering',
    target: `fixture ${name}`,
    input: { format: value.input.format, payload: value.input.payload },
  }, {})
}

await testAsync('adjudication_plan consumes the artifact seed through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path').expect
  const plan = await planFor(ctx, 'happy-path')

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'artifact-observations')
  assert.equal(plan.candidateSet.inputFormat, 'artifact-and-observations')
  assert.equal(plan.candidateSet.bounded, false, 'a C domain must report an unbounded candidate set')
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.ok(plan.candidateSet.notes.some((note) => note.includes('候选集不可先验枚举、成本无上界')))
  assert.equal(plan.gate.admitted, happy.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 're-lead')
  assert.equal(plan.bundleKey.derived, happy.admitted)
  assert.equal(plan.bundles.length, happy.bundles)
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), happy.bundleKeys)
  const byKey = new Map(plan.bundles.map((item) => [item.key, item]))
  for (const [key, size] of Object.entries(happy.bundleSizes)) {
    assert.equal(byKey.get(key)?.paths.length, size, `bundle ${key} holds ${size} candidates`)
  }
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
  for (const bundle of plan.bundles) assert.ok(bundle.rules.length > 0, `bundle ${bundle.key} got no rules`)
})

await testAsync('the plan over the empty seed says so, and still carries the unbounded-cost note', async () => {
  const ctx = createPluginContext()
  const plan = await planFor(ctx, 'empty')
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /不要凭空审核/u)
  assert.match(plan.summary, /候选集不可先验枚举、成本无上界/u, 'the report itself must carry the cost model, not just the enumerator')
  assert.match(plan.summary, /空集本身不是通过/u)
  assert.equal(plan.candidateSet.bounded, false)
})

await testAsync('the plan over the all-gated-out seed reports every gate reason — on the PACK gate alone', async () => {
  const ctx = createPluginContext()
  // CHANGED (t33/t24): this test used to assert `admitted: 6` and explain the
  // gap in a comment, because the fixture's own `**/archive/**` + 1200-byte
  // narrowing never reached the plugin. That gap IS the defect being fixed: the
  // boundary must hold through the REAL plan with nothing but the pack's own
  // gate applying, and every excluded path must name the predicate that fired.
  assert.equal(fixture('all-gated-out').gate, undefined, 'the fixture must not declare a gate any more')
  const plan = await planFor(ctx, 'all-gated-out')
  for (const item of plan.gate.excluded) {
    assert.ok(typeof item.predicate === 'string' && item.predicate.length > 0, `excluded "${item.path}" names no predicate`)
  }
  assert.deepEqual(byPredicate(plan.gate), fixture('all-gated-out').expect.excludedByPredicate)
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /准入 0 项/u)
  assert.match(plan.summary, /排除 15 项/u)
  assert.match(plan.summary, /候选集不可先验枚举、成本无上界/u)
})

await testAsync('the plan over the unverified seed keeps the hypotheses and their missing steps visible', async () => {
  const ctx = createPluginContext()
  const plan = await planFor(ctx, 'unverified-observation')
  assert.equal(plan.gate.admitted, 5)
  assert.equal(plan.bundles.length, 1)
  assert.equal(plan.bundles[0].key, 're/bootrom-x/observations/boot-loader')
  assert.ok(plan.candidateSet.notes.some((note) => note.includes('全部没有可复现步骤')))
  assert.equal(plan.bundleKey.derived, 5)
})

await testAsync('P0 -> P5 -> P7 round trip: the ENGINE recomputes every anchor, and lies do not survive', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const sha = happy.input.payload.artifact.sha256
  const plan = await planFor(ctx, 'happy-path')
  const documents = documentsFor('happy-path')

  const findings = [
    // Real: a reproduced observation.
    { id: 'f1', severity: 'high', message: '未认证 UART shell 可直接进入', path: 're/fw-1.2.3/observations/auth-flow.md', sha256: sha, verified: true, evidence: 'statement o-uart-shell :: The firmware exposes a UART shell on pin 12 without authentication.', locator: { artifactId: 'fw-1.2.3', sha256: sha, kind: 'statement', observationId: 'o-uart-shell', verified: true } },
    // Real, and honestly labelled as a guess: it must SURVIVE (recall-first).
    { id: 'f2', severity: 'medium', message: '配置块疑似固定 IV 的 AES-128-CBC（猜想）', path: 're/fw-1.2.3/observations/auth-flow.md', sha256: sha, verified: false, evidence: 'statement o-crypto-guess :: The configuration blob is probably AES-128-CBC with a fixed IV.', locator: { artifactId: 'fw-1.2.3', sha256: sha, kind: 'statement', observationId: 'o-crypto-guess', verified: false } },
    // Real: the reproduction line of the protocol observation.
    { id: 'f3', severity: 'low', message: '协议框架可复现', path: 're/fw-1.2.3/observations/protocol.md', sha256: sha, verified: true, evidence: 'repro o-protocol :: steps=3 tool=scapy 2.5.0 verified=true', locator: { artifactId: 'fw-1.2.3', sha256: sha, kind: 'repro', observationId: 'o-protocol', verified: true } },
    // A LIE: the steps=0 inference presented as verified, with a self-reported anchor.
    { id: 'f4', severity: 'critical', message: '推断被写成已验证的观察', path: 're/fw-1.2.3/observations/auth-flow.md', sha256: sha, verified: true, anchored: true, start: 42, evidence: 'statement o-crypto-guess :: The configuration blob is probably AES-128-CBC with a fixed IV.', locator: { artifactId: 'fw-1.2.3', sha256: sha, kind: 'statement', observationId: 'o-crypto-guess', verified: true } },
    // A second LIE: the same quotation, attributed to a different sample.
    { id: 'f5', severity: 'high', message: '结论来自另一个样本', path: 're/fw-1.2.3/observations/auth-flow.md', sha256: 'f'.repeat(64), verified: true, evidence: 'statement o-uart-shell :: The firmware exposes a UART shell on pin 12 without authentication.', locator: { artifactId: 'fw-1.2.3', sha256: 'f'.repeat(64), kind: 'statement', observationId: 'o-uart-shell', verified: true } },
  ]

  // The plugin's anchor surface routes through the domain verifier. The artifact
  // hash line is printed in EVERY lead's note, so a chain-level claim quoting only
  // the hash is genuinely ambiguous — the verifier says so instead of picking a
  // lead. A statement line, which belongs to exactly one note, anchors.
  const viaHash = await ctx.__tools.get('adjudication_anchor').execute(
    { domain: 'reverse-engineering', excerpt: `artifact.sha256 = ${sha}`, path: 're/fw-1.2.3/observations/auth-flow.md', documents }, {},
  )
  assert.equal(viaHash.via, 'anchorVerifier')
  assert.equal(viaHash.status, 'unanchored')
  assert.equal(viaHash.tier, 'relocation-ambiguous')
  assert.ok(viaHash.ambiguousIn.length >= 2, `the hash line lives in every note: ${viaHash.ambiguousIn.join(', ')}`)

  const viaTool = await ctx.__tools.get('adjudication_anchor').execute(
    {
      domain: 'reverse-engineering',
      excerpt: 'statement o-strings :: The string `X-Auth-Debug` appears in the release binary.',
      path: 're/fw-1.2.3/observations/protocol.md',
      documents,
    }, {},
  )
  assert.equal(viaTool.via, 'anchorVerifier')
  assert.equal(viaTool.status, 'anchored')
  assert.equal(viaTool.code, 'artifact-confirmed')
  assert.match(viaTool.detail, /未确认具体观察/u)

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'reverse-engineering',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    documents,
    findings,
  }, {})

  assert.equal(submitted.unanchored, 2, 'the engine refused the two false anchors, not this file')
  assert.equal(submitted.findings.length, 3)
  const tiers = submitted.findings.map((finding) => finding.anchorTier)
  assert.ok(tiers.every((tier) => TRUSTED_ANCHOR_TIERS.includes(tier)), `untrusted tier in ${tiers.join(', ')}`)
  assert.ok(submitted.findings.every((finding) => Number.isInteger(finding.start) && finding.start > 0), 'the engine must supply the recomputed line numbers')
  assert.equal(submitted.coverage.total, plan.gate.admitted)
  assert.equal(submitted.coverage.total, happy.expect.admitted)
  assert.equal(submitted.coverage.reviewed, 2, 'two distinct note files were reviewed')
  assert.ok(Number.isInteger(submitted.coverage.reviewed) && submitted.coverage.reviewed > 0, 'reviewed must be an exact count, not a bound')
  assert.equal(submitted.coverage.coverageRate, Number((submitted.coverage.reviewed / submitted.coverage.total).toFixed(4)), 'the rate is exactly reviewed/total, not an upper bound')
  assert.equal(submitted.coverage.coverageRate, Number((2 / happy.expect.admitted).toFixed(4)))
  assert.equal(submitted.coverage.complete, false, 'a C domain must never read as complete')
  assert.equal(submitted.coverage.required, true)
  assert.equal(submitted.criticismKind, 'triage')
  assert.match(submitted.summary, /自报的 anchored\/start 一律不采信/u)
  assert.match(submitted.summary, /未通过/u)
  assert.match(submitted.summary, /recall-first/u)
})

await testAsync('the complete-coverage branch: one note, one path, and the report says so', async () => {
  const ctx = createPluginContext()
  const one = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'reverse-engineering',
    target: 'single-note probe',
    candidates: [{ path: 're/bootrom-x/observations/boot-loader.md' }],
  }, {})
  assert.equal(one.bundleKey.applied, true)
  assert.equal(one.bundles.length, 1)
  assert.equal(one.bundles[0].key, 're/bootrom-x/observations/boot-loader')

  const sha = fixture('unverified-observation').input.payload.artifact.sha256
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'reverse-engineering',
    target: 'single-note probe',
    total: 1,
    admitted: 1,
    bundles: 1,
    documents: documentsFor('unverified-observation'),
    findings: [{
      id: 'f1',
      severity: 'medium',
      message: 'CRC32 校验仍属猜想',
      path: 're/bootrom-x/observations/boot-loader.md',
      sha256: sha,
      verified: false,
      evidence: 'statement o-guess :: The bootloader probably checks a CRC32 before jumping to the application.',
      locator: { artifactId: 'bootrom-x', sha256: sha, kind: 'statement', observationId: 'o-guess', verified: false },
    }],
  }, {})

  assert.equal(submitted.unanchored, 0)
  assert.equal(submitted.coverage.total, 1)
  assert.equal(submitted.coverage.reviewed, 1)
  assert.equal(submitted.coverage.coverageRate, 1)
  assert.equal(submitted.coverage.complete, true)
  assert.doesNotMatch(submitted.summary, /未通过/u)
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'reverse-engineering' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName('reverse-engineering', tool.name)), `${tool.name} must be registered on activation`)
  }
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'reverse-engineering' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('reverse-engineering', tool.name)), false)
  }
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'reverse-engineering' }, {})
  const listed = await ctx.__tools.get('adjudicate_reverse_engineering_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'reverse-engineering',
    target: 'replacement probe',
    candidates: [
      { path: 're/a/observations/x.md' },
      { path: 're/a/observations/x.md' },
      { path: 're/a/observations/y.md' },
      { path: 're/a/observations/y.md' },
    ],
  }, {})
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['re/a/observations/x', 're/a/observations/y'])
  assert.equal(plan.bundles.length, 2, 'four candidates from two leads must not become four bundles')
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19)
  assert.ok(listed.directory.replaced.includes('reverse-engineering'))
})

// ---------------------------------------------------------------------------
// The REAL plugin path — self-folded subjects
// ---------------------------------------------------------------------------

console.log('\nthrough the REAL adjudication_anchor — every fixture case is reachable')

/**
 * What a caller actually hands back: the payload file (the reviewed input
 * material) plus the documents of the review.
 *
 * The engine collapses `subject` to `{path, content, documents}` and drops every
 * structured domain field (`lineage` / `experiments` / `sources` / `artifact`), so
 * this — not the convenient direct-call shape — is what a verifier sees in
 * production. Each fixture case therefore carries the payload BOTH as its own
 * `{path, content}` (self-folded subject) and as a document; the assertions below
 * prove the domain reads the payload back out of that collapsed form and still
 * runs the FULL recomputation on it (a payload that disagrees is still refused).
 */
const documentsFromCase = (subject) => {
  const documents = []
  if (typeof subject?.path === 'string' && typeof subject?.content === 'string') {
    documents.push({ path: subject.path, content: subject.content })
  }
  for (const document of subject?.documents ?? []) documents.push({ path: document.path, content: document.content })
  return documents
}

/** The same case with every structured field removed — the engine's collapsed shape. */
const strippedSubject = (subject) => ({
  path: subject?.path,
  content: subject?.content,
  documents: (subject?.documents ?? []).map((document) => ({ path: document.path, content: document.content })),
})

const viaRealAnchor = async (ctx, domain, entry) => ctx.__tools.get('adjudication_anchor').execute({
  domain,
  excerpt: entry.claim.excerpt,
  path: entry.claim.path,
  locator: entry.claim.locator,
  // CHANGED (t33/t37): `kind` used to be ignored (the engine always passed
  // `pack.anchorVerifier.kind`), so the kind-mismatch case could not be routed
  // through the real tool. t37 made a caller-supplied kind win, so the case now
  // travels the real path like every other one — the last "collapsed differs
  // from direct" exception is gone.
  kind: entry.claim.kind,
  documents: documentsFromCase(entry.subject),
}, {})

await testAsync('all 6 positive anchor cases anchor through the REAL adjudication_anchor (6/6)', async () => {
  const ctx = createPluginContext()
  const cases = fixture('happy-path').anchors.positive
  assert.equal(cases.length, 6, 'the reachability baseline t21 measured is this many positive cases')
  const failures = []
  let anchored = 0
  for (const entry of cases) {
    const result = await viaRealAnchor(ctx, 'reverse-engineering', entry)
    assert.equal(result.via, 'anchorVerifier', `领域验证器没跑（引擎兜底了）：${entry.note}`)
    if (result.status === 'anchored') { anchored += 1; continue }
    failures.push(`${entry.note} -> ${result.tier}/${result.code}`)
  }
  assert.deepEqual(failures, [], `未锚定：${failures.join(' | ')}`)
  assert.equal(anchored, 6)
})

await testAsync('every fixture case survives losing the structured fields (the engine\'s collapsed shape)', async () => {
  let checked = 0
  for (const [name, value] of FIXTURES) {
    for (const group of ['positive', 'negative', 'ambiguous']) {
      for (const entry of value.anchors[group] ?? []) {
        const withFields = anchor.verify(entry.claim, entry.subject)
        const folded = anchor.verify(entry.claim, strippedSubject(entry.subject))
        assert.equal(folded.status, withFields.status, `[${name}/${group}] ${entry.note}`)
        assert.equal(folded.tier, withFields.tier, `[${name}/${group}] ${entry.note}`)
        if (withFields.code !== undefined) assert.equal(folded.code, withFields.code, `[${name}/${group}] ${entry.note}`)
        checked += 1
      }
    }
  }
  assert.ok(checked >= 16, `only ${checked} anchor cases were checked`)
})

await testAsync('every negative case is refused through the REAL tool with the same tier as direct verify', async () => {
  const ctx = createPluginContext()
  let refused = 0
  let kindMismatchCases = 0
  for (const [name, value] of FIXTURES) {
    for (const entry of value.anchors.negative ?? []) {
      if (entry.claim.kind !== anchor.kind) kindMismatchCases += 1
      const result = await viaRealAnchor(ctx, 'reverse-engineering', entry)
      assert.equal(result.via, 'anchorVerifier')
      assert.equal(result.status, 'unanchored', `[${name}] ${entry.note}`)
      assert.equal(result.tier, entry.expectTier, `[${name}] ${entry.note}`)
      if (entry.expectCode !== undefined) assert.equal(result.code, entry.expectCode, `[${name}] 拒绝理由必须经真实路径也一致：${entry.note}`)
      assert.equal(result.path, null)
      assert.equal(result.start, null)
      refused += 1
    }
  }
  assert.ok(refused >= 10, `only ${refused} negative cases were routed`)
  assert.equal(kindMismatchCases, 1, 'exactly one kind-mismatch case exists — and it is routed, not skipped')
})

await testAsync('an ambiguous case stays ambiguous through the REAL tool (the verifier refuses to pick)', async () => {
  const ctx = createPluginContext()
  let checked = 0
  for (const [name, value] of FIXTURES) {
    for (const entry of value.anchors.ambiguous ?? []) {
      const result = await viaRealAnchor(ctx, 'reverse-engineering', entry)
      assert.equal(result.via, 'anchorVerifier', `[${name}] ${entry.note}`)
      assert.equal(result.status, 'unanchored', `[${name}] ${entry.note}`)
      assert.equal(result.tier, entry.expectTier, `[${name}] ${entry.note}`)
      assert.ok(Array.isArray(result.ambiguousIn) && result.ambiguousIn.length > 1, `[${name}] 歧义必须列出全部竞争位置`)
      checked += 1
    }
  }
  assert.ok(checked >= 2, `only ${checked} ambiguous cases were routed`)
})

await testAsync('the self-folded payload is still FULLY recomputed: another sample hash is refused', async () => {
  // The anti-forgery proof: the self-folded subject is not a structure the
  // verifier can skip over. Take a positive case, keep its subject shape
  // byte-for-byte, and only make the payload DISAGREE — the verdict must flip.
  const entry = fixture('happy-path').anchors.positive[0]
  const subject = strippedSubject(entry.subject)
  assert.equal(anchor.verify(entry.claim, subject).status, 'anchored', 'the untouched self-folded subject must anchor first')
  const data = JSON.parse(subject.content)
  data.artifact.sha256 = 'e'.repeat(64)
  const text = JSON.stringify(data)
  const tampered = {
    path: subject.path,
    content: text,
    documents: (subject.documents ?? []).map((document) => (document.path === subject.path ? { path: document.path, content: text } : { path: document.path, content: document.content })),
  }
  const verdict = anchor.verify(entry.claim, tampered)
  assert.equal(verdict.status, 'unanchored', 'a registry about another build cannot anchor a finding about this one')
  assert.equal(verdict.code, 'artifact-mismatch')
})

// ---------------------------------------------------------------------------
// t33/t24 — the pack owns its boundary, the interface is real, the bound is reached
// ---------------------------------------------------------------------------

console.log('\nt33/t24 — pack-owned boundary, published interface, reached bound')

test('no fixture narrows the gate: the all-gated-out boundary belongs to the pack', () => {
  // The defect (t24-F1 / the §1.4 audit): this domain reached `admitted: 0` only
  // because the fixture itself contributed an `archive/` exclusion, which the pack
  // did not declare and `adjudication_plan` cannot even pass. A directory-level
  // scan is the only form that cannot be defeated by adding one more fixture.
  for (const file of FIXTURE_FILES) {
    const raw = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
    assert.ok(!Object.hasOwn(raw, 'gate'), `${file} declares a gate block — that is the fixture's rule, not the pack's`)
  }
  const text = FIXTURE_FILES.map((file) => readFileSync(join(here, 'fixtures', file), 'utf8')).join('\n')
  assert.ok(!/"gate"\s*:/u.test(text), 'no fixture may declare a gate block')
  // Key form, not the bare word: prose that EXPLAINS the removed defect is
  // allowed, a fixture that brings the narrowing back is not.
  assert.ok(!/"maxFileBytes"\s*:/u.test(text), 'no fixture may carry maxFileBytes: the pack has no such field')
  assert.ok(!/"exclude"\s*:/u.test(text), 'no fixture may carry a gate exclude list')
  assert.ok(!/"extensions"\s*:/u.test(text), 'no fixture may carry a gate extension list')
  assert.ok(pack.gate.exclude.includes('**/archive/**'), 'the exclusion the boundary needs is declared by the pack')
})

const rulesForPath = async (ctx, path) => {
  const result = await ctx.__tools.get('adjudicate_reverse_engineering_plan').execute({
    target: 'support-table',
    candidates: [{ id: 'support-probe', path, locator: { probe: path }, text: `probe line for ${path}` }],
  }, {})
  return {
    admitted: result.gate.admitted,
    rules: (result.bundles ?? []).reduce((total, bundle) => total + (bundle.rules ?? []).length, 0),
  }
}

await testAsync('the support boundary is measured, not assumed: declared extension x path class', async () => {
  // t33 asked whether "declared support" is nominal, and the two detection lines
  // disagreed because they measured different things: `match` is "any glob hits",
  // and a DIRECTORY glob covers its whole subtree. Same `.md`, two answers: under
  // the observations/ subtree it is inside the rule globs, elsewhere only the
  // generic json/log fallbacks apply. The table is the measurement, through the
  // real plan.
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'reverse-engineering' }, {})
  // pinned numbers: changing them means changing what this domain supports.
  // Order = `[...pack.gate.extensions].sort()`, so a new declaration shows up as
  // a missing row rather than as a silently unmeasured extension.
  const TABLE = [
    { extension: '.json', inside: 're/bin/observations/note.json', outside: 're/bin/thread/lead.json', insideRules: 20, outsideRules: 20 },
    { extension: '.md', inside: 're/bin/observations/note.md', outside: 're/bin/thread/lead.md', insideRules: 20, outsideRules: 0 },
    { extension: '.txt', inside: 're/bin/observations/note.txt', outside: 're/bin/thread/lead.txt', insideRules: 20, outsideRules: 0 },
  ]
  assert.deepEqual(TABLE.map((row) => row.extension), [...(pack.gate.extensions ?? [])].sort(),
    'every declared extension needs a row — a new declaration must come with its measurement')
  for (const row of TABLE) {
    const inside = await rulesForPath(ctx, row.inside)
    const outside = await rulesForPath(ctx, row.outside)
    assert.equal(inside.admitted, 1, `${row.inside} must be admitted (the question is what it gets, not whether it passes)`)
    assert.equal(outside.admitted, 1, `${row.outside} must be admitted`)
    assert.equal(inside.rules, row.insideRules, `${row.extension} under the observations/ subtree got ${inside.rules} rules`)
    assert.equal(outside.rules, row.outsideRules, `${row.extension} outside the rule subtree got ${outside.rules} rules`)
    // The non-negotiable half of the criterion: a DECLARED extension at this
    // domain's documented input location must not be starved.
    assert.ok(inside.rules >= 1, `declared extension ${row.extension} gets no rule where this domain actually reads it`)
  }
  assert.match(pack.summary, /支持边界/u, 'the boundary has to be stated where a user reads it, not only here')

  // The same property on REAL input: drive the plan through this domain's own P0
  // enumerator (`input`, not hand-fed candidates) over every fixture. Nothing may
  // be admitted and then left without a single rule — the empty intersection must
  // not be able to hide behind one hand-fed path.
  let injectedBundles = 0
  for (const file of FIXTURE_FILES) {
    const value = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
    const planned = await ctx.__tools.get('adjudicate_reverse_engineering_plan').execute({
      target: 'support-table',
      input: { format: pack.candidateSet.inputFormat, payload: value.input.payload },
    }, {})
    for (const bundle of planned.bundles ?? []) {
      injectedBundles += 1
      assert.ok((bundle.rules ?? []).length >= 1, `${file}: bundle ${bundle.key} was admitted but got 0 rules through the real plan`)
    }
  }
  assert.ok(injectedBundles > 0, 'the measurement must not be vacuous: no fixture produced a bundle')
})

const evidenceSource = readFileSync(join(here, 'evidence.js'), 'utf8')

/**
 * The `args.<key>` keys a tool's `execute` body reads, module-scope helpers
 * included. Static on purpose: it must fail when someone adds a read the
 * published schema does not describe, which is the one thing eight "declared
 * schema" mutations proved nothing here checked (t24-F2) — two tools here threw
 * for a caller who followed the published schema.
 */
function readKeysOf(source, toolName) {
  const block = (text, start) => {
    let depth = 0
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
    }
    return text.slice(start)
  }
  const keysIn = (text) => new Set([...text.matchAll(/args\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]))
  const helpers = new Map()
  for (const match of source.matchAll(/^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gmu)) helpers.set(match[1], keysIn(block(source, source.indexOf('{', match.index + match[0].length - 1))))
  for (const match of source.matchAll(/^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\([^)]*\)\s*=>\s*\{/gmu)) helpers.set(match[1], keysIn(block(source, source.indexOf('{', match.index + match[0].length - 1))))
  const names = [...source.matchAll(/name:\s*'([a-z_]+)',/gu)]
  const index = names.findIndex((match) => match[1] === toolName)
  if (index === -1) return null
  const chunk = source.slice(names[index].index, index + 1 < names.length ? names[index + 1].index : source.length)
  const used = new Set(keysIn(chunk))
  for (const [name, keys] of helpers) {
    if (new RegExp(`\\b${name}\\s*\\(`, 'u').test(chunk)) for (const key of keys) used.add(key)
  }
  return [...used].sort()
}

test('the published parameters schema COVERS the implementation (t33/t24-F2)', () => {
  for (const tool of evidence.tools) {
    const reads = readKeysOf(evidenceSource, tool.name)
    assert.ok(reads !== null, `evidence.js has no tool named ${tool.name}`)
    const declared = Object.keys(tool.parameters?.properties ?? {})
    assert.deepEqual(reads.filter((key) => !declared.includes(key)), [],
      `${tool.name} reads args.<key> keys its published schema does not declare — a caller following the schema cannot call it`)
  }
})

const SCHEMA_VALUES = {
  path: NOTES[0].path,
  start: 1,
  documents: NOTES,
  sha256: 'a'.repeat(64),
  registry: REGISTRY,
}

await testAsync('a caller that follows the published schema succeeds, key by key (t33/t24-F2)', async () => {
  // The strongest form of the check: build args from the DECLARED properties
  // ONLY. A tool that reads an undeclared context key gets nothing and throws.
  for (const tool of evidence.tools) {
    const declared = Object.keys(tool.parameters?.properties ?? {})
    assert.deepEqual(declared.filter((key) => !(key in SCHEMA_VALUES)), [],
      `the test has no value for a declared key of ${tool.name} — the check would be vacuous`)
    const args = {}
    for (const key of declared) args[key] = SCHEMA_VALUES[key]
    const result = await tool.execute(args, {})
    assert.ok(Array.isArray(result.items) && typeof result.truncated === 'boolean' && typeof result.provenance === 'string')
  }
})

const BIG_NOTE = { path: 're/big/observations/big.md', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
const BIG_CONTEXT = {
  note_excerpt: { path: BIG_NOTE.path, start: 1, documents: [BIG_NOTE] },
  reproduction_check: {
    registry: {
      artifact: { id: 'big', sha256: 'a'.repeat(64) },
      observations: Array.from({ length: 200 }, (_, index) => ({ id: `o${index}`, kind: 'observation', lead: 'big', verified: true, reproducibility: { steps: ['a', 'b'] } })),
    },
  },
  sample_identity: { sha256: 'a'.repeat(64), registry: REGISTRY, documents: NOTES },
}
// sample_identity compares ONE declared hash against ONE registered artifact, so
// its count is 1 by construction and the truncation branch is unreachable. That
// is declared in the source (and asserted here) rather than left as head-room no
// input can fill.
const SINGLE_ITEM_BY_CONSTRUCTION = { sample_identity: 'unreachable by design' }

await testAsync('every tool that declares an item bound has a case that REACHES it (t33/t24-F3)', async () => {
  // t24-F3: the suites proved a bound exists somewhere, not that each declared
  // bound is reachable, so growing a `maxItems` left them green. Each tool now has
  // an over-limit input; the assertion is the exact count, not a bound.
  for (const name of Object.keys(SINGLE_ITEM_BY_CONSTRUCTION)) {
    assert.ok(evidence.tools.some((tool) => tool.name === name), `SINGLE_ITEM_BY_CONSTRUCTION names a tool that does not exist: ${name}`)
  }
  for (const tool of evidence.tools) {
    const args = BIG_CONTEXT[tool.name]
    assert.ok(args !== undefined, `${tool.name} declares limits but has no over-limit case`)
    const result = await tool.execute(args, {})
    assert.ok(result.items.length <= tool.limits.maxItems, `${tool.name} returned more items than it declares`)
    const byConstruction = SINGLE_ITEM_BY_CONSTRUCTION[tool.name]
    if (byConstruction === undefined) {
      assert.equal(result.items.length, tool.limits.maxItems, `${tool.name} must return exactly maxItems items when more were available`)
      assert.equal(result.truncated, true, `${tool.name} must SAY it truncated`)
    } else {
      assert.equal(result.items.length, tool.limits.maxItems)
      assert.equal(result.truncated, false)
      assert.ok(evidenceSource.includes(byConstruction), 'an unreachable truncation branch must be declared as such in the source')
    }
    assert.ok(typeof result.provenance === 'string' && result.provenance.length > 0, `${tool.name} must say what it read`)
  }
})

await testAsync('the declared maxCalls is ENFORCED per activation, not decorative (t33/t24-F3)', async () => {
  // The second half of t24-F3: `maxCalls` used to be a number nobody executed.
  // The engine now counts per (domain, tool) per activation, and this runs the
  // over-limit case through the REGISTERED tool so a regression cannot hide.
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'reverse-engineering' }, {})
  const name = 'adjudicate_reverse_engineering_evidence_note_excerpt'
  const args = { path: NOTES[0].path, start: 1, documents: NOTES }
  const maxCalls = evidence.tools.find((tool) => tool.name === 'note_excerpt').limits.maxCalls
  for (let call = 1; call <= maxCalls; call += 1) await ctx.__tools.get(name).execute(args, {})
  await assert.rejects(() => ctx.__tools.get(name).execute(args, {}), (error) => new RegExp(`maxCalls=${maxCalls}`, 'u').test(String(error?.message ?? error)))
  // A fresh activation starts a fresh budget: one run must not poison the tool.
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'reverse-engineering' }, {})
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'reverse-engineering' }, {})
  const again = await ctx.__tools.get(name).execute(args, {})
  assert.ok(Array.isArray(again.items), 'the budget is per activation, not per process')
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
