/**
 * algo-model — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  one candidate per (experiment, metric)
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey                  ->  one bundle per EXPERIMENT
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  metric recomputed from the tracker export
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 * ------------------------------------
 * 1. It never asserts a status without asserting the tier AND the domain code.
 *    "anchored" alone is satisfiable by a verifier that guesses; the tier says it
 *    did not, and `code` says whether the METRIC was confirmed in the records.
 * 2. It never lets P4 and P6 share a prompt (the validators do not check it).
 * 3. It never hands `adjudication_submit` an anchor it made up: the engine
 *    recomputes every finding through this domain's verifier, and one claim in
 *    the round trip is a deliberate paraphrase so the ENGINE, not this file, is
 *    the thing that refuses it.
 *
 * Usage: `node domains/algo-model/test.mjs`
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
import source, { chainKey, chainKeyFromPath, metricLine, renderExperiment } from './source.js'
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
    if (!map[item.predicate]) map[item.predicate] = []
    map[item.predicate].push(item.path)
  }
  for (const key of Object.keys(map)) map[key].sort()
  return map
}

function keyedAdmitted(name) {
  const { result } = runP0P1(name)
  return result.selected.map((entry) => {
    const resolution = resolveBundleKey(pack, entry, {})
    return resolution.applied ? { ...entry, key: resolution.key } : entry
  })
}

/**
 * The documents a reviewer hands back: the record card of each experiment, plus
 * the tracker export itself under the domain convention
 * (`experiments/records.json`). The engine's recompute path can only pass a
 * verifier `{path, content, document, documents}`, so the records travel as a
 * document — the export checked is the one the plan was given.
 */
function documentsFor(name) {
  const payload = fixture(name).input.payload
  const documents = payload.experiments.map((experiment) => ({
    path: `experiments/${String(experiment.id).toLowerCase()}/metrics.json`,
    content: renderExperiment(experiment),
  }))
  documents.push({ path: 'experiments/records.json', content: JSON.stringify({ experiments: payload.experiments }) })
  return documents
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\nalgo-model domain — contract v2 end-to-end')
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
  const declared = inputFormatFor('algo-model')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(source.bounded, true)
  assert.equal(declared.bounded, true)
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
    { name: 'csv-only', match: ['**/*.csv'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['experiments/vision/model-v1/metrics.json'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  assert.ok(FIXTURES.has('missing-baseline'))
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

test('boundary: an empty experiment set produces an EMPTY candidate set, and an empty gate', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  const expected = fixture('empty').expect
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path), expected.paths)
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
  assert.equal(empty.result.selected.length, 0)
  // CHANGED (t33/t24): the weak form ("something was excluded") is gone — the
  // count is exact and every exclusion is pinned to the predicate that fired.
  assert.equal(gatedOut.enumerated.candidates.length, fixture('all-gated-out').expect.candidates)
  assert.equal(gatedOut.result.selected.length, 0, 'all-gated-out: P1 admitted NOTHING')
  assert.equal(gatedOut.result.excluded.length, fixture('all-gated-out').expect.candidates)
  assert.deepEqual(byPredicate(gatedOut.result), fixture('all-gated-out').expect.excludedByPredicate)
})

test('happy path: one candidate per (experiment, metric), all admitted', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
  // The granularity IS the domain: every metric of every experiment is its own
  // candidate, so 「单题分数高不等于整体好转」 is checkable one line at a time.
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.deepEqual(ids, [
    'vision/model-v1#metric#accuracy',
    'vision/model-v1#metric#f1',
    'vision/model-v2#metric#accuracy',
    'vision/model-v2#metric#f1',
    'vision/model-v3#metric#auc',
  ])
})

test('the source names the two structural facts the reviewer needs', () => {
  const happy = source.enumerate(fixture('happy-path').input.payload, {})
  assert.ok(happy.notes.some((note) => /单题分数高不等于整体好转/u.test(note)), 'the per-metric duty must be stated every run')
  assert.ok(happy.notes.some((note) => /口径不一致/u.test(note)), 'the f1 definition drift must be reported')
  const alpha = source.enumerate(fixture('missing-baseline').input.payload, {})
  assert.ok(alpha.notes.some((note) => /没有 baseline/u.test(note)), 'a baseline-less experiment must be called out')
  const drifted = source.enumerate(fixture('happy-path').input.payload, {}).candidates.filter((candidate) => candidate.meta.definitionDrift)
  assert.deepEqual(drifted.map((candidate) => candidate.id), ['vision/model-v1#metric#f1', 'vision/model-v2#metric#f1'])
})

test('the gate is the engine\'s ordered predicate list, and the pack only narrows it', () => {
  assert.deepEqual(gate([], {}).ordered, DEFAULT_GATE_PREDICATES.map(([label]) => label))
  // CHANGED (t33/t24): the old form required every pack pattern to be an engine
  // default, which cannot express a domain-owned exclusion. `**/legacy/**` is
  // declared by the pack, and it is what makes the all-gated-out boundary hold
  // without the fixture narrowing anything.
  assert.deepEqual(pack.gate.exclude, ['**/.git/**', '**/dist/**', '**/build/**', '**/legacy/**'])
  assert.ok(pack.gate.exclude.includes('**/legacy/**'), 'the domain-owned exclusion must live in the pack')
  assert.ok(!pack.gate.exclude.includes('**/vendor/**'), 'vendor is covered by default-path')
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ experiments: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ experiments: [] }, {}))
})

test('a malformed `baseline` is REFUSED, never silently read as "no baseline"', () => {
  // `"baseline": "纯噪声 0.978 / 合成光栅 0.509"` is what a caller writes when
  // they have a baseline and the schema wants `{ id, metrics? }`. Reading the
  // string as ABSENT is not lenient, it is wrong: "no baseline" is a MEANINGFUL
  // state here and it produces a real finding — the experiment gets accused of
  // supporting a claim it was never supposed to support. A refused call is
  // strictly better than a false accusation, so the malformed shape throws.
  const stringBaseline = { experiments: [{ id: 'e1', baseline: '纯噪声 0.978', metrics: [{ name: 'm', value: 1 }] }] }
  assert.throws(() => source.enumerate(stringBaseline, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate(stringBaseline, {}), /baseline 必须是对象/u)
  assert.throws(() => source.enumerate({ experiments: [{ id: 'e1', baseline: 42, metrics: [{ name: 'm', value: 1 }] }] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ experiments: [{ id: 'e1', baseline: ['noise'], metrics: [{ name: 'm', value: 1 }] }] }, {}), /E_INPUT_FORMAT/u)

  // The two legitimate spellings of "this experiment has no baseline" still mean
  // exactly that — the new check must not make the normal case louder.
  assert.doesNotThrow(() => source.enumerate({ experiments: [{ id: 'e1', metrics: [{ name: 'm', value: 1 }] }] }, {}))
  assert.doesNotThrow(() => source.enumerate({ experiments: [{ id: 'e1', baseline: null, metrics: [{ name: 'm', value: 1 }] }] }, {}))

  // SHAPE CONTROL: a well-formed baseline is accepted AND produces no warning,
  // so the assertion above is not passing merely because nothing ever warns.
  const good = source.enumerate({ experiments: [{ id: 'e1', baseline: { id: 'noise' }, metrics: [{ name: 'm', value: 1 }] }] }, {})
  assert.doesNotMatch(JSON.stringify(good), /没有 baseline/u)
  const none = source.enumerate({ experiments: [{ id: 'e1', metrics: [{ name: 'm', value: 1 }] }] }, {})
  assert.match(JSON.stringify(none), /没有 baseline/u)
})

test('candidate ids are unique and `path` stays a gate-globable file path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u)
    assert.match(candidate.path, /^[a-z0-9][a-z0-9._:/-]*$/u, 'the gate cannot glob this path')
    assert.equal(typeof candidate.locator.experimentId, 'string')
    assert.equal(typeof candidate.locator.metricName, 'string')
  }
})

test('the candidate text is a real line of the record card the verifier will read', () => {
  const payload = fixture('happy-path').input.payload
  for (const experiment of payload.experiments) {
    const card = renderExperiment(experiment)
    for (const metric of experiment.metrics) {
      const line = metricLine(experiment, metric)
      assert.ok(line.startsWith('metric '), `${line} must be a metric line`)
      assert.ok(card.includes(line), `the card must contain "${line}" verbatim — otherwise every anchor fails by construction`)
    }
  }
})

test('a metric with an artifact kind is routed to its artifact path, not to metrics.json', () => {
  const enumerated = source.enumerate(fixture('all-gated-out').input.payload, {})
  const artifact = enumerated.candidates.find((candidate) => candidate.id === 'vision/weights-only#metric#weights')
  assert.equal(artifact.path, 'experiments/vision/weights-only/weights.bin')
  assert.equal(artifact.meta.metricKind, 'artifact')
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling by experiment')

test('bundleKey is a v2 object whose private strategy supplies its own resolver', () => {
  const declared = pack.bundleKey
  assert.equal(typeof declared, 'object')
  assert.equal(declared.strategy, 'experiment')
  assert.ok(!['path', 'file', 'directory', 'extension'].includes(declared.strategy), 'a generic strategy cannot express "one experiment"')
  assert.equal(typeof declared.resolve, 'function')
  assert.equal(declared.resolve({ path: 'experiments/vision/model-v1/metrics.json' }), 'vision/model-v1')
  assert.notEqual(declared.resolve({ path: 'experiments/vision/model-v1/metrics.json' }), 'experiments/vision/model-v1/metrics.json')
})

test('every metric of one experiment lands in ONE bundle — not one bundle per candidate', () => {
  const keyed = keyedAdmitted('happy-path')
  assert.ok(keyed.length >= 4, 'bundle() short-circuits below 4 entries; this fixture must be past that')

  const bundled = bundle(keyed)
  assert.deepEqual(bundled.bundles.map((item) => item.key).sort(), fixture('happy-path').expect.bundleKeys)
  assert.equal(bundled.bundles.length, fixture('happy-path').expect.bundles)
  assert.equal(bundled.degraded, false)

  const byKey = new Map(bundled.bundles.map((item) => [item.key, item.entries]))
  for (const [left, right] of fixture('happy-path').expect.sameBundle) {
    const owner = [...byKey.entries()].find(([, entries]) => entries.some((entry) => entry.id === left))
    assert.ok(owner !== undefined, `${left} must be in some bundle`)
    assert.ok(owner[1].some((entry) => entry.id === right), `${left} and ${right} must share one bundle (got ${owner[0]})`)
  }
  for (const [key, size] of Object.entries(fixture('happy-path').expect.bundleSizes)) {
    assert.equal(byKey.get(key)?.length, size, `bundle ${key} size`)
  }

  // The counterfactual the acceptance warns about: one bundle per CANDIDATE.
  const naive = bundle(keyed.map((entry) => ({ ...entry, key: entry.id })))
  assert.equal(naive.bundles.length, keyed.length)
  assert.ok(bundled.bundles.length < naive.bundles.length)
})

test('the pack\'s resolver agrees with the source\'s own notion of a chain', () => {
  const { result } = runP0P1('happy-path')
  for (const entry of result.selected) assert.equal(pack.bundleKey.resolve(entry), chainKey(entry))
  assert.equal(chainKeyFromPath('dags/x.sql'), 'dags/x.sql', 'a foreign path must not become an invented experiment')
})

test('resolveBundleKey reports the resolver as applied/derived for every candidate', () => {
  const { result } = runP0P1('happy-path')
  for (const entry of result.selected) {
    const resolution = resolveBundleKey(pack, entry, {})
    assert.equal(resolution.applied, true)
    assert.equal(resolution.source, 'derived')
    assert.equal(resolution.strategy, 'experiment')
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
      assert.equal(verdict.status, entry.expectStatus, entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      if (entry.expectCode !== undefined) assert.equal(verdict.code, entry.expectCode, entry.note)
      if (entry.expectPath !== undefined) assert.equal(verdict.path, entry.expectPath)
      if (entry.expectStart !== undefined) assert.equal(verdict.start, entry.expectStart)
      if (verdict.status === 'anchored') {
        assert.ok(TRUSTED_ANCHOR_TIERS.includes(verdict.tier), `tier "${verdict.tier}" is not trusted`)
        assert.equal(typeof verdict.detail, 'string')
      }
    })
  }
  for (const entry of value.anchors.negative ?? []) {
    test(`anchor negative [${name}] -> ${entry.expectTier}/${entry.expectCode ?? '?'}`, () => {
      const verdict = verifyFromCase(entry)
      assert.equal(verdict.status, entry.expectStatus, entry.note)
      assert.equal(verdict.tier, entry.expectTier, entry.note)
      if (entry.expectCode !== undefined) assert.equal(verdict.code, entry.expectCode, entry.note)
      assert.equal(verdict.start, null, 'an unanchored verdict must not carry a line number')
      assert.equal(verdict.path, null)
      if (entry.expectKnownMetrics !== undefined) assert.deepEqual(verdict.knownMetrics, entry.expectKnownMetrics)
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

test('a paraphrase never anchors, even when the numbers are right', () => {
  const verdict = anchor.verify(
    { kind: 'experiment-metric', path: 'experiments/vision/model-v1/metrics.json', locator: { experimentId: 'vision/model-v1', metricName: 'accuracy' }, excerpt: 'accuracy reached 91.2 percent' },
    {
      path: 'experiments/vision/model-v1/metrics.json',
      content: 'metric accuracy = 0.912\n',
      experiments: [{ id: 'vision/model-v1', metrics: [{ name: 'accuracy', value: 0.912 }] }],
    },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('the metric check runs BEFORE the text check: a real line cannot prove a metric of another experiment', () => {
  const records = { experiments: [{ id: 'a', metrics: [{ name: 'accuracy', value: 0.9 }] }, { id: 'b', metrics: [{ name: 'f1', value: 0.8 }] }] }
  const subject = { path: 'experiments/a/metrics.json', content: 'metric f1 = 0.8\n', experiments: records.experiments }
  const bad = anchor.verify({ kind: 'experiment-metric', path: 'experiments/a/metrics.json', locator: { experimentId: 'a', metricName: 'f1' }, excerpt: 'metric f1 = 0.8' }, subject)
  assert.equal(bad.status, 'unanchored')
  assert.equal(bad.code, 'metric-unconfirmed', 'experiment b has f1 — that must not confirm a claim about experiment a')
  assert.deepEqual(bad.knownMetrics, ['accuracy'])
})

test('without the tracker records the verifier refuses rather than falling back to text', () => {
  const verdict = anchor.verify(
    { kind: 'experiment-metric', path: 'experiments/a/metrics.json', locator: { experimentId: 'a', metricName: 'accuracy' }, excerpt: 'metric accuracy = 0.9' },
    { path: 'experiments/a/metrics.json', content: 'metric accuracy = 0.9\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-documents')
  assert.equal(verdict.code, 'no-records')
})

test('a structured payload document is DATA, not prose: an excerpt never relocates into it', () => {
  // CHANGED (anchor-preview): the old input quoted `metric accuracy = 0.9` while
  // the only document was a PRETTY-PRINTED export. That could not fail for the
  // reason the title gives — a JSON line is wrapped in its own quotes and keys, so
  // it can never equal a bare prose line, and the assertion was passing on the
  // unrelated `named === null` branch. The needle is now the export's own single
  // line, which the export genuinely does contain: without the
  // `isStructuredDocument` filter this WOULD anchor, so the title's property is
  // what is being tested.
  const content = JSON.stringify({ experiments: [{ id: 'a', metrics: [{ name: 'accuracy', value: 0.9 }] }] })
  const verdict = anchor.verify(
    { kind: 'experiment-metric', path: 'experiments/a/metrics.json', locator: { experimentId: 'a', metricName: 'accuracy' }, excerpt: content },
    { path: 'experiments/a/metrics.json', documents: [{ path: 'experiments/records.json', content }] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('that refusal NAMES the structured export instead of denying it holds the text', () => {
  // The behaviour above is deliberate, but the old detail said「与任何可比对文档都不含这段原文」
  // while the supplied document demonstrably DID contain it. A false reason sends
  // the caller hunting for a typo that is not there; the refusal has to say which
  // document holds the text and why it still does not count, and point at the card.
  const content = JSON.stringify({ experiments: [{ id: 'a', metrics: [{ name: 'accuracy', value: 0.9 }] }] })
  const verdict = anchor.verify(
    { kind: 'experiment-metric', path: 'experiments/a/metrics.json', locator: { experimentId: 'a', metricName: 'accuracy' }, excerpt: content },
    { path: 'experiments/a/metrics.json', documents: [{ path: 'experiments/records.json', content }] },
  )
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /experiments\/records\.json/u, 'the refusal must name the document that holds the text')
  assert.match(verdict.detail, /DATA/u, 'and say why it still does not count as quoted prose')
  assert.match(verdict.detail, /记录卡/u, 'and point at what SHOULD be quoted')
})

test('the card the domain renders is a LAST RESORT, and only for the experiment’s own card path', () => {
  // The work order prints `metric accuracy = 0.9` and `submit` demands it back
  // verbatim, but that line is RENDERED from the record — it is a line of no file
  // on disk, so before the fallback the loop was unclosable (six `no-match`
  // refusals in a real session, zero anchored findings, P6 never running).
  const records = { experiments: [{ id: 'a', metrics: [{ name: 'accuracy', value: 0.9, definition: 'top-1' }] }] }
  const documents = [{ path: 'experiments/records.json', content: JSON.stringify(records) }]
  const subject = { path: 'experiments/a/metrics.json', documents }
  const claim = (excerpt, path = 'experiments/a/metrics.json') => ({
    kind: 'experiment-metric', path, locator: { experimentId: 'a', metricName: 'accuracy' }, excerpt,
  })

  const printed = source.enumerate({ experiments: records.experiments }, {}).candidates[0].text
  assert.equal(printed, 'metric accuracy = 0.9', 'the line the work order shows is the line submit will require')

  const anchored = anchor.verify(claim(printed), subject)
  assert.equal(anchored.status, 'anchored')
  assert.equal(anchored.tier, 'recomputed-unique')
  assert.equal(anchored.code, 'metric-confirmed')

  // SHAPE CONTROL 1: the fallback is a LAST resort, not a bypass — the record is
  // still recomputed first, and the quote must match it. A paraphrase is refused.
  const paraphrased = anchor.verify(claim('accuracy 0.9'), subject)
  assert.equal(paraphrased.status, 'unanchored')
  assert.equal(paraphrased.tier, 'no-match')

  // SHAPE CONTROL 2: a claim naming some OTHER path gets no card at all — the
  // domain renders exactly one card per experiment, at its own convention path.
  const otherPath = anchor.verify(claim(printed, 'experiments/b/metrics.json'), { path: 'experiments/a/metrics.json', documents })
  assert.equal(otherPath.status, 'unanchored')
  assert.equal(otherPath.tier, 'no-match')
})

test('a wrong line number is refused rather than repaired', () => {
  const verdict = anchor.verify(
    { kind: 'experiment-metric', path: 'experiments/a/metrics.json', locator: { experimentId: 'a', metricName: 'accuracy', startLine: 99 }, excerpt: 'metric accuracy = 0.9' },
    { path: 'experiments/a/metrics.json', content: 'metric accuracy = 0.9\n', experiments: [{ id: 'a', metrics: [{ name: 'accuracy', value: 0.9 }] }] },
  )
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'experiment-metric' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'experiment-metric', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['experiments/vision/model-v2/metrics.json'],
  bundle: { key: 'vision/model-v2', paths: ['experiments/vision/model-v2/metrics.json'], rules: ['metric-definition-drift'] },
  ruleText: '<rules path="experiments/vision/model-v2/metrics.json">\n指标定义漂移：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', path: 'experiments/vision/model-v2/metrics.json', experimentId: 'vision/model-v2', metricName: 'f1', evidence: 'metric f1 = 0.879', message: 'f1 从 0.881 退到 0.879', defended: true },
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
  assert.match(P4.system, /指标定义漂移/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /指标定义漂移/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts carry the domain laws: the metric rule, the number rule and the 口径 rule', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /行号/u)
    assert.match(text, /指标/u)
    assert.match(text, /口径/u)
  }
  assert.match(P4.system, /单题分数高不等于整体好转/u)
  assert.match(P4.system, /不要输出行号|永远不要输出行号/u)
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
})

// ---------------------------------------------------------------------------
// P7 — evidence tools
// ---------------------------------------------------------------------------

console.log('\nP7 — bounded evidence tools')

const RECORDS = {
  experiments: [
    { id: 'vision/model-v1', metrics: [{ name: 'accuracy', value: 0.912, definition: 'top-1 accuracy on the test split' }, { name: 'f1', value: 0.881, definition: 'macro-F1 over the 10 classes' }] },
    { id: 'vision/model-v2', metrics: [{ name: 'f1', value: 0.879, definition: 'micro-F1 over all classes' }], baseline: { id: 'vision/model-v1', metrics: [{ name: 'f1', value: 0.881 }] } },
  ],
}
const CARDS = [{ path: 'experiments/vision/model-v1/metrics.json', content: 'metric accuracy = 0.912\nmetric f1 = 0.881\n' }]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('experiment_card reads at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('experiment_card')
  const big = { path: 'experiments/vision/big/metrics.json', content: Array.from({ length: 400 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 'experiments/vision/big/metrics.json', start: 1, documents: [big] }, {})
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.ok(result.provenance.length > 0)
})

await testAsync('metric_delta refuses when there is no baseline instead of returning a zero delta', async () => {
  const tool = toolByName('metric_delta')
  const without = { experiments: [{ id: 'a', metrics: [{ name: 'accuracy', value: 0.9 }] }] }
  assert.throws(() => tool.execute({ experimentId: 'a', records: without }, {}), /没有 baseline/u)
  const result = await tool.execute({ experimentId: 'vision/model-v2', records: RECORDS }, {})
  assert.deepEqual(result.items.map((item) => `${item.metricName}:${item.delta}`), ['f1:-0.002'])
  assert.match(result.notes.join(' '), /单题 delta 只是单题/u)
})

await testAsync('definition_compare surfaces 口径不一致 for a drifted metric', async () => {
  const tool = toolByName('definition_compare')
  const result = await tool.execute({ metricName: 'f1', records: RECORDS }, {})
  assert.deepEqual(result.items.map((item) => item.experimentId), ['vision/model-v1', 'vision/model-v2'])
  assert.match(result.provenance, /2 种口径/u)
  assert.match(result.notes.join(' '), /口径不一致/u)
})

await testAsync('a request with no injected context is refused, not answered with "nothing found"', async () => {
  assert.throws(() => toolByName('metric_delta').execute({ experimentId: 'a' }, {}), /缺少 `records`/u)
  assert.throws(() => toolByName('experiment_card').execute({ path: 'experiments/x/metrics.json' }, {}), /缺少 `documents`/u)
  assert.throws(() => toolByName('experiment_card').execute({ path: 'experiments/none/metrics.json', documents: CARDS }, {}), /文档集里没有/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('algo-model', 'metric_delta'), 'adjudicate_algo_model_evidence_metric_delta')
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

test('recall-first keeps what it cannot disprove and drops only what is disproved', () => {
  const panel = runCritiquePanel([
    { id: 'suspicion', path: 'experiments/a/metrics.json', severity: 'low', evidence: '' },
    { id: 'refuted', path: 'experiments/b/metrics.json', severity: 'high', evidence: 'x', defended: true, disproved: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['suspicion'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['refuted'])
  assert.equal(panel.kind, 'triage')
})

test('the report carries the domain, the orientation, the criticism kind and the recall-first requirement', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 'experiments/a/metrics.json', severity: 'high', evidence: 'x', defended: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 5, excluded: 0, bundles: 3 },
    findings: panel.kept,
    coverageProof: coverage(5, panel.kept, { requireComplete: true }),
    budget: createBudget({}),
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'algo-model')
  assert.equal(built.lossOrientation, 'recall-first')
  assert.equal(built.criticismKind, 'triage')
  assert.equal(built.coverage.total, 5)
  assert.equal(built.coverage.reviewed, 1)
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
  const loaded = await loadDomain(io, { id: 'algo-model', dir: 'domains/algo-model' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'experiment-metrics')
  assert.equal(assembled.anchorVerifier.kind, 'experiment-metric')
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
    domain: 'algo-model',
    target: `fixture ${name}`,
    input: { format: value.input.format, payload: value.input.payload },
  }, {})
}

await testAsync('adjudication_plan consumes the tracker export through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await planFor(ctx, 'happy-path')

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'experiment-metrics')
  assert.equal(plan.candidateSet.inputFormat, 'experiment-record')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.ok(plan.candidateSet.notes.some((note) => /单题分数高不等于整体好转/u.test(note)))
  assert.ok(plan.candidateSet.notes.some((note) => /口径不一致/u.test(note)))
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'experiment')
  assert.equal(plan.bundleKey.derived, happy.expect.admitted)
  assert.equal(plan.bundles.length, happy.expect.bundles)
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), happy.expect.bundleKeys)
  const byKey = new Map(plan.bundles.map((item) => [item.key, item]))
  for (const [key, size] of Object.entries(happy.expect.bundleSizes)) {
    assert.equal(byKey.get(key)?.paths.length, size, `bundle ${key} holds ${size} candidates`)
  }
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
  for (const bundle of plan.bundles) assert.ok(bundle.rules.length > 0, `bundle ${bundle.key} got no rules`)
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const plan = await planFor(ctx, 'empty')
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /不要凭空审核/u)
  assert.equal(plan.bundleKey.applied, false)
  assert.match(plan.bundleKey.reason, /没有准入候选/u)
})

await testAsync('the plan over the all-gated-out fixture reports every gate reason — on the PACK gate alone', async () => {
  const ctx = createPluginContext()
  // CHANGED (t33/t24): this test used to assert `admitted: 2` and explain the
  // gap in a comment, because the fixture's own `**/legacy/**` + 300-byte
  // narrowing never reached the plugin. That gap IS the defect being fixed: the
  // boundary must hold through the REAL plan with nothing but the pack's own
  // gate applying, and every excluded path must name the predicate that fired.
  assert.equal(fixture('all-gated-out').gate, undefined, 'the fixture must not declare a gate any more')
  const plan = await planFor(ctx, 'all-gated-out')
  const predicates = {}
  for (const item of plan.gate.excluded) {
    assert.ok(typeof item.predicate === 'string' && item.predicate.length > 0, `excluded "${item.path}" names no predicate`)
    ;(predicates[item.predicate] ??= []).push(item.path)
  }
  for (const key of Object.keys(predicates)) predicates[key].sort()
  assert.deepEqual(predicates, fixture('all-gated-out').expect.excludedByPredicate)
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /准入 0 项/u)
  assert.match(plan.summary, /排除 4 项/u)
})

await testAsync('P0 -> P5 -> P7 round trip: the ENGINE recomputes every anchor, and coverage is real', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await planFor(ctx, 'happy-path')
  const documents = documentsFor('happy-path')

  // Three real findings (one per experiment) and one deliberate paraphrase.
  // Which survive is decided by the domain verifier inside the engine.
  const findings = [
    { id: 'f1', severity: 'medium', message: 'model-v2 的 f1 从 0.881 退到 0.879，总体 accuracy 上升掩盖了它', path: 'experiments/vision/model-v2/metrics.json', evidence: 'metric f1 = 0.879', locator: { experimentId: 'vision/model-v2', metricName: 'f1', value: 0.879 }, defended: true },
    { id: 'f2', severity: 'high', message: 'model-v2 的 f1 口径与 model-v1 不同，跨实验比较不成立', path: 'experiments/vision/model-v2/metrics.json', evidence: 'metric f1.definition = micro-F1 over all classes', locator: { experimentId: 'vision/model-v2', metricName: 'f1' }, defended: true },
    { id: 'f3', severity: 'low', message: 'model-v3 只有单次运行的 auc，没有离散度', path: 'experiments/vision/model-v3/metrics.json', evidence: 'metric auc = 0.71', locator: { experimentId: 'vision/model-v3', metricName: 'auc', value: 0.71 }, defended: true },
    { id: 'f4', severity: 'high', message: '转述出来的断言', path: 'experiments/vision/model-v1/metrics.json', evidence: 'accuracy reached 91.2 percent', locator: { experimentId: 'vision/model-v1', metricName: 'accuracy' } },
  ]

  // The plugin's anchor surface routes through the domain verifier; without a
  // locator it can only confirm the EXPERIMENT, and it says so.
  const viaTool = await ctx.__tools.get('adjudication_anchor').execute(
    { domain: 'algo-model', excerpt: 'metric accuracy = 0.912', path: 'experiments/vision/model-v1/metrics.json', documents }, {},
  )
  assert.equal(viaTool.via, 'anchorVerifier')
  assert.equal(viaTool.status, 'anchored')
  assert.equal(viaTool.code, 'experiment-confirmed')
  assert.match(viaTool.detail, /指标未确认/u)

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'algo-model',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    documents,
    findings,
  }, {})

  assert.equal(submitted.unanchored, 1, 'the engine refused the paraphrase, not this file')
  assert.equal(submitted.findings.length, 3)
  assert.equal(submitted.coverage.total, plan.gate.admitted)
  assert.equal(submitted.coverage.total, happy.expect.admitted)
  // f1 and f2 sit in the SAME experiment record; coverage counts distinct
  // PATHS, so two findings about one record are one reviewed path. The rate is
  // therefore 2/5 — the number follows the input, it is not asserted into being.
  assert.equal(submitted.coverage.reviewed, 2, 'two distinct experiment records were reviewed')
  assert.ok(Number.isInteger(submitted.coverage.reviewed) && submitted.coverage.reviewed > 0, 'reviewed must be an exact count, not a bound')
  assert.equal(submitted.coverage.coverageRate, Number((submitted.coverage.reviewed / submitted.coverage.total).toFixed(4)), 'the rate is exactly reviewed/total, not an upper bound')
  assert.equal(submitted.coverage.coverageRate, Number((2 / happy.expect.admitted).toFixed(4)))
  assert.equal(submitted.coverage.complete, false)
  assert.equal(submitted.coverage.required, true)
  assert.equal(submitted.criticismKind, 'triage')
  assert.match(submitted.summary, /自报的 anchored\/start 一律不采信/u)
  assert.match(submitted.summary, /未通过/u)
  assert.match(submitted.summary, /recall-first/u)
})

await testAsync('the complete-coverage branch: one candidate, one path, no 未通过', async () => {
  const ctx = createPluginContext()
  const plan = await planFor(ctx, 'missing-baseline')
  assert.equal(plan.gate.admitted, 1)
  assert.equal(plan.bundles[0].key, 'vision/model-alpha')
  assert.ok(plan.candidateSet.notes.some((note) => /没有 baseline/u.test(note)))

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'algo-model',
    target: 'fixture missing-baseline',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    documents: documentsFor('missing-baseline'),
    findings: [{
      id: 'f1',
      severity: 'high',
      message: '没有 baseline，0.77 无法说明任何提升',
      path: 'experiments/vision/model-alpha/metrics.json',
      evidence: 'metric precision = 0.77',
      locator: { experimentId: 'vision/model-alpha', metricName: 'precision' },
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
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'algo-model' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName('algo-model', tool.name)), `${tool.name} must be registered on activation`)
  }
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'algo-model' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('algo-model', tool.name)), false)
  }
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'algo-model' }, {})
  const listed = await ctx.__tools.get('adjudicate_algo_model_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'algo-model',
    target: 'replacement probe',
    candidates: [
      { path: 'experiments/vision/model-v1/metrics.json' },
      { path: 'experiments/vision/model-v1/metrics.json' },
      { path: 'experiments/vision/model-v2/metrics.json' },
      { path: 'experiments/vision/model-v2/metrics.json' },
    ],
  }, {})
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['vision/model-v1', 'vision/model-v2'])
  assert.equal(plan.bundles.length, 2, 'four candidates from two experiments must not become four bundles')
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19)
  assert.ok(listed.directory.replaced.includes('algo-model'))
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

await testAsync('all 5 positive anchor cases anchor through the REAL adjudication_anchor (5/5)', async () => {
  const ctx = createPluginContext()
  const cases = fixture('happy-path').anchors.positive
  assert.equal(cases.length, 5, 'the reachability baseline t21 measured is this many positive cases')
  const failures = []
  let anchored = 0
  for (const entry of cases) {
    const result = await viaRealAnchor(ctx, 'algo-model', entry)
    assert.equal(result.via, 'anchorVerifier', `领域验证器没跑（引擎兜底了）：${entry.note}`)
    if (result.status === 'anchored') { anchored += 1; continue }
    failures.push(`${entry.note} -> ${result.tier}/${result.code}`)
  }
  assert.deepEqual(failures, [], `未锚定：${failures.join(' | ')}`)
  assert.equal(anchored, 5)
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
  assert.ok(checked >= 13, `only ${checked} anchor cases were checked`)
})

await testAsync('every negative case is refused through the REAL tool with the same tier as direct verify', async () => {
  const ctx = createPluginContext()
  let refused = 0
  let kindMismatchCases = 0
  for (const [name, value] of FIXTURES) {
    for (const entry of value.anchors.negative ?? []) {
      if (entry.claim.kind !== anchor.kind) kindMismatchCases += 1
      const result = await viaRealAnchor(ctx, 'algo-model', entry)
      assert.equal(result.via, 'anchorVerifier')
      assert.equal(result.status, 'unanchored', `[${name}] ${entry.note}`)
      assert.equal(result.tier, entry.expectTier, `[${name}] ${entry.note}`)
      if (entry.expectCode !== undefined) assert.equal(result.code, entry.expectCode, `[${name}] 拒绝理由必须经真实路径也一致：${entry.note}`)
      assert.equal(result.path, null)
      assert.equal(result.start, null)
      refused += 1
    }
  }
  assert.ok(refused >= 8, `only ${refused} negative cases were routed`)
  assert.equal(kindMismatchCases, 1, 'exactly one kind-mismatch case exists — and it is routed, not skipped')
})

await testAsync('an ambiguous case stays ambiguous through the REAL tool (the verifier refuses to pick)', async () => {
  const ctx = createPluginContext()
  let checked = 0
  for (const [name, value] of FIXTURES) {
    for (const entry of value.anchors.ambiguous ?? []) {
      const result = await viaRealAnchor(ctx, 'algo-model', entry)
      assert.equal(result.via, 'anchorVerifier', `[${name}] ${entry.note}`)
      assert.equal(result.status, 'unanchored', `[${name}] ${entry.note}`)
      assert.equal(result.tier, entry.expectTier, `[${name}] ${entry.note}`)
      assert.ok(Array.isArray(result.ambiguousIn) && result.ambiguousIn.length > 1, `[${name}] 歧义必须列出全部竞争位置`)
      checked += 1
    }
  }
  assert.ok(checked >= 2, `only ${checked} ambiguous cases were routed`)
})

await testAsync('the self-folded payload is still FULLY recomputed: a record without the claimed metric is refused', async () => {
  // The anti-forgery proof: the self-folded subject is not a structure the
  // verifier can skip over. Take a positive case, keep its subject shape
  // byte-for-byte, and only make the payload DISAGREE — the verdict must flip.
  const entry = fixture('happy-path').anchors.positive[0]
  const subject = strippedSubject(entry.subject)
  assert.equal(anchor.verify(entry.claim, subject).status, 'anchored', 'the untouched self-folded subject must anchor first')
  const data = JSON.parse(subject.content)
  for (const experiment of data.experiments) {
    experiment.metrics = experiment.metrics.filter((metric) => metric.name !== 'accuracy')
  }
  const text = JSON.stringify(data)
  const tampered = {
    path: subject.path,
    content: text,
    documents: (subject.documents ?? []).map((document) => (document.path === subject.path ? { path: document.path, content: text } : { path: document.path, content: document.content })),
  }
  const verdict = anchor.verify(entry.claim, tampered)
  assert.equal(verdict.status, 'unanchored', 'a record that no longer lists the metric cannot anchor it')
  assert.equal(verdict.code, 'metric-unconfirmed')
})

// ---------------------------------------------------------------------------
// t33/t24 — the pack owns its boundary, the interface is real, the bound is reached
// ---------------------------------------------------------------------------

console.log('\nt33/t24 — pack-owned boundary, published interface, reached bound')

test('no fixture narrows the gate: the all-gated-out boundary belongs to the pack', () => {
  // The defect (t24-F1 / the §1.4 audit): this domain reached `admitted: 0` only
  // because the fixture itself contributed `"exclude": ["**/legacy/**"]`, which the
  // pack did not declare and `adjudication_plan` cannot even pass. A
  // directory-level scan is the only form that cannot be defeated by adding one
  // more fixture.
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
  assert.ok(pack.gate.exclude.includes('**/legacy/**'), 'the exclusion the boundary needs is declared by the pack')
})

const rulesForPath = async (ctx, path) => {
  const result = await ctx.__tools.get('adjudicate_algo_model_plan').execute({
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
  // and a DIRECTORY glob covers its whole subtree. Same `.md`, two answers: inside
  // `experiments/` it is inside the rule globs, elsewhere only the generic
  // `*.json` fallback applies. The table below is the measurement, through the
  // real plan.
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'algo-model' }, {})
  // pinned numbers: changing them means changing what this domain supports.
  // Order = `[...pack.gate.extensions].sort()`, so a new declaration shows up as
  // a missing row rather than as a silently unmeasured extension.
  const TABLE = [
    { extension: '.csv', inside: 'experiments/vision/probe.csv', outside: 'reports/summary.csv', insideRules: 23, outsideRules: 0 },
    { extension: '.json', inside: 'experiments/vision/probe.json', outside: 'reports/summary.json', insideRules: 23, outsideRules: 23 },
    { extension: '.md', inside: 'experiments/vision/probe.md', outside: 'reports/summary.md', insideRules: 23, outsideRules: 0 },
    { extension: '.txt', inside: 'experiments/vision/probe.txt', outside: 'reports/summary.txt', insideRules: 23, outsideRules: 0 },
    { extension: '.yaml', inside: 'experiments/vision/probe.yaml', outside: 'reports/summary.yaml', insideRules: 23, outsideRules: 0 },
    { extension: '.yml', inside: 'experiments/vision/probe.yml', outside: 'reports/summary.yml', insideRules: 23, outsideRules: 0 },
  ]
  assert.deepEqual(TABLE.map((row) => row.extension), [...(pack.gate.extensions ?? [])].sort(),
    'every declared extension needs a row — a new declaration must come with its measurement')
  for (const row of TABLE) {
    const inside = await rulesForPath(ctx, row.inside)
    const outside = await rulesForPath(ctx, row.outside)
    assert.equal(inside.admitted, 1, `${row.inside} must be admitted (the question is what it gets, not whether it passes)`)
    assert.equal(outside.admitted, 1, `${row.outside} must be admitted`)
    assert.equal(inside.rules, row.insideRules, `${row.extension} under experiments/ got ${inside.rules} rules`)
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
    const planned = await ctx.__tools.get('adjudicate_algo_model_plan').execute({
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
 * schema" mutations proved nothing here checked (t24-F2).
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
  path: 'experiments/vision/model-v1/metrics.json',
  start: 1,
  end: 3,
  documents: CARDS,
  experimentId: 'vision/model-v2',
  metricName: 'accuracy',
  records: RECORDS,
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

const BIG_METRICS = Array.from({ length: 200 }, (_, index) => ({ name: `m${index}`, value: 0.5 + index / 1000, definition: `definition ${index}` }))
const BIG_DELTA_RECORDS = {
  experiments: [
    { id: 'big', metrics: BIG_METRICS, baseline: { id: 'base', metrics: BIG_METRICS.map((metric) => ({ name: metric.name, value: metric.value - 0.01, definition: metric.definition })) } },
    { id: 'base', metrics: BIG_METRICS },
  ],
}
const BIG_SURVEY_RECORDS = {
  experiments: Array.from({ length: 200 }, (_, index) => ({ id: `e${index}`, metrics: [{ name: 'm0', value: index, definition: `definition of experiment ${index}` }] })),
}
const BIG_CARD = { path: 'experiments/vision/big/metrics.json', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
const BIG_CONTEXT = {
  experiment_card: { path: BIG_CARD.path, start: 1, documents: [BIG_CARD] },
  metric_delta: { experimentId: 'big', records: BIG_DELTA_RECORDS },
  definition_compare: { metricName: 'm0', records: BIG_SURVEY_RECORDS },
}
// No tool here has an unreachable truncation branch: all three declare an item
// bound they can actually reach.
const SINGLE_ITEM_BY_CONSTRUCTION = {}

await testAsync('every tool that declares an item bound has a case that REACHES it (t33/t24-F3)', async () => {
  // t24-F3: the suites proved a bound exists somewhere, not that each declared
  // bound is reachable, so growing a `maxItems` 500x left them green. Each tool
  // now has an over-limit input; the assertion is the exact count, not a bound.
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
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'algo-model' }, {})
  const name = 'adjudicate_algo_model_evidence_experiment_card'
  const args = { path: CARDS[0].path, start: 1, documents: CARDS }
  const maxCalls = evidence.tools.find((tool) => tool.name === 'experiment_card').limits.maxCalls
  for (let call = 1; call <= maxCalls; call += 1) await ctx.__tools.get(name).execute(args, {})
  await assert.rejects(() => ctx.__tools.get(name).execute(args, {}), (error) => new RegExp(`maxCalls=${maxCalls}`, 'u').test(String(error?.message ?? error)))
  // A fresh activation starts a fresh budget: one run must not poison the tool.
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'algo-model' }, {})
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'algo-model' }, {})
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
