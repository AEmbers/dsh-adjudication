/**
 * data-engineering — domain end-to-end test (contract v2, `test.mjs`).
 *
 * Runs the whole pipeline over this domain's own fixtures:
 *
 *   P0  candidateSource.enumerate  ->  deterministic candidate set
 *   P1  gate                       ->  admitted / excluded, with reasons
 *   P2  bundleKey                  ->  real grouping (not one-per-path)
 *   P3  ruleLibrary                ->  >= 20 agent-drafted rules injected
 *   P4  reviewPrompts.review       ->  bounded review prompt
 *   P5  anchorVerifier.verify      ->  edge recomputed from the lineage graph
 *   P6  reviewPrompts.verify       ->  a prompt that is NOT the P4 prompt
 *   P7  evidenceTools              ->  bounded, truncated-when-cut, provenance
 *
 * Then it drives the assembled pack through the plugin's own mock Cordis
 * context, so the domain is proven to work where it is actually used and not
 * merely in isolation.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 * ------------------------------------
 * 1. It never asserts a status without asserting the tier AND the domain code.
 *    "anchored" alone is satisfiable by a verifier that guesses; the tier says
 *    it did not, and `code` says whether the EDGE was confirmed in the graph.
 * 2. It never lets P4 and P6 share a prompt (the validators do not check it).
 * 3. It never hands `adjudication_submit` an anchor it made up. Every finding
 *    that reaches submit has been through `anchor.verify` first, and one claim
 *    in the round trip is a deliberate paraphrase so the verifier — not this
 *    file — is the thing that refuses it.
 *
 * ON THE COVERAGE DENOMINATOR: `coverage()` counts DISTINCT REVIEWED PATHS
 * against the admitted candidate count. A lineage file carries several
 * candidates (its edges plus its columns), so a small rate on `happy-path` is
 * the arithmetic, not a hidden failure — and because this domain is
 * recall-first, an incomplete coverage is reported as 未通过. `single-chain`
 * pins the other branch: when the admitted set really is one candidate on one
 * path, the same code path reports complete coverage.
 *
 * Usage: `node domains/data-engineering/test.mjs`
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
import source, { chainKey, edgeConfirmed, lineageEdges } from './source.js'
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

/**
 * Enumerate + gate one fixture with the PACK's gate alone.
 *
 * CHANGED (t33/t24): this helper used to merge `value.gate.exclude` and
 * `value.gate.maxFileBytes` into the gate, which meant the `all-gated-out`
 * boundary was reached by a rule the pack does not declare — and, for
 * data-engineering, by a `maxFileBytes` field the pack's gate does not even
 * have. A fixture may no longer narrow anything: every fixture in this domain
 * is now required to carry NO `gate` block at all (asserted below), and the
 * boundary is asserted against the REAL plan, where only the pack's own gate
 * exists.
 */
function runP0P1(name) {
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

/** Apply the pack's OWN bundleKey to the admitted set, exactly as the plan does. */
function keyedAdmitted(name) {
  const { result } = runP0P1(name)
  return result.selected.map((entry) => {
    const resolution = resolveBundleKey(pack, entry, {})
    return resolution.applied ? { ...entry, key: resolution.key } : entry
  })
}

// ---------------------------------------------------------------------------
// Pack identity
// ---------------------------------------------------------------------------

console.log('\ndata-engineering domain — contract v2 end-to-end')
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
  const declared = inputFormatFor('data-engineering')
  assert.equal(declared.format, source.inputFormat)
  assert.equal(pack.candidateSet.inputFormat, source.inputFormat)
  assert.equal(pack.candidateSet.kind, source.kind)
  assert.equal(source.bounded, true)
  assert.equal(declared.bounded, true)
})

test('the anchor kind agrees across pack, anchor.kind and the verifier', () => {
  assert.equal(pack.anchor.kind, anchor.kind)
  assert.equal(pack.anchor.verify, anchor.verifyLevel)
  assert.equal(anchor.verifyLevel, 'engine-recomputable', 'this anchor must be recomputable by the engine, not merely re-checkable by a human')
})

test('criticism.kind agrees with the loss orientation', () => {
  assert.equal(pack.lossOrientation, 'recall-first')
  assert.equal(pack.criticism.kind, 'triage')
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

test('rule selection injects only rules that match the bundle paths', () => {
  const selected = selectRules([
    { name: 'py-only', match: ['**/*.py'], text: 'x'.repeat(20) },
    { name: 'any', match: ['**/*'], text: 'y'.repeat(20) },
  ], ['dags/clean_orders.sql'])
  assert.deepEqual(selected.injected.map((rule) => rule.name), ['any'])
})

test('the SQL rules really reach a SQL bundle, and a .py file does not get the SQL-only rules', () => {
  const rules = RULE_FILES.map((file) => {
    const text = readFileSync(join(here, 'rules', file), 'utf8')
    const name = /^name:\s*(.+)$/mu.exec(text)?.[1]?.trim()
    const match = [...text.matchAll(/^\s+-\s+"(.+)"$/gmu)].map((hit) => hit[1])
    return { name, match, text: 'z'.repeat(20) }
  })
  const sqlBundle = selectRules(rules, ['models/analytics/orders_daily.sql']).injected.map((rule) => rule.name)
  assert.ok(sqlBundle.includes('lineage-edge-declared-not-real'), 'a SQL bundle must get the lineage rules')
  assert.ok(sqlBundle.includes('column-nullability-relaxed'), 'a SQL bundle must get the column rules')
  const dagBundle = selectRules(rules, ['dags/nightly.py']).injected.map((rule) => rule.name)
  assert.ok(dagBundle.includes('run-failure-ignored'), 'a DAG file must get the orchestration rules')
  assert.ok(!dagBundle.includes('column-nullability-relaxed'), 'a .py file must not claim the SQL-only column rules')
})

test('the fixtures required by the contract are all present', () => {
  for (const name of MANDATORY_FIXTURES) {
    assert.ok(FIXTURES.has(name), `missing mandatory fixture "${name}"`)
  }
  // The two extra fixtures this domain ships are the ones its own structure
  // needs: the orphan-table boundary and a chain small enough to be covered 100%.
  assert.ok(FIXTURES.has('orphan-column'))
  assert.ok(FIXTURES.has('single-chain'))
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

test('boundary: an empty lineage graph produces an EMPTY candidate set, and an empty gate', () => {
  const { enumerated, result } = runP0P1('empty')
  assert.deepEqual(validateCandidateSetResult(enumerated), [])
  const expected = fixture('empty').expect
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.deepEqual(enumerated.candidates.map((candidate) => candidate.path), expected.paths)
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded.length, 0)
  assert.equal(enumerated.excluded.length, expected.sourceExcluded)
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
  assert.equal(empty.result.selected.length, 0)
  // CHANGED (t33/t24): the weak form ("something was excluded") is gone. The
  // number is exact, and each exclusion is pinned to the predicate that fired —
  // a change in which rule fires is a change in the report's reason and must be
  // visible rather than silent.
  assert.equal(gatedOut.enumerated.candidates.length, fixture('all-gated-out').expect.candidates,
    'all-gated-out: P0 produced something')
  assert.equal(gatedOut.result.selected.length, 0, 'all-gated-out: P1 admitted NOTHING')
  assert.equal(gatedOut.result.excluded.length, fixture('all-gated-out').expect.candidates)
  const predicates = byPredicate(gatedOut.result)
  assert.deepEqual(predicates, fixture('all-gated-out').expect.excludedByPredicate)
  assert.deepEqual(Object.keys(predicates).sort(), ['default-path', 'deleted', 'extension', 'user-exclude'],
    'four different predicates must do the excluding, not one blanket rule')
})

test('happy path: every candidate the graph implies is admitted', () => {
  const expected = fixture('happy-path').expect
  const { enumerated, result } = runP0P1('happy-path')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.deepEqual(result.excluded, [])
})

test('boundary: an orphan table and an orphan node are REPORTED, not silently enumerated', () => {
  const expected = fixture('orphan-column').expect
  const { enumerated, result } = runP0P1('orphan-column')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
  assert.equal(enumerated.excluded.length, expected.sourceExcluded)
  const reasons = enumerated.excluded.map((entry) => entry.reason).join('\n')
  for (const fragment of expected.sourceExcludedReasons) {
    assert.match(reasons, new RegExp(fragment, 'u'), `the source must explain the ${fragment}`)
  }
  // The orphan table's columns must not have been enumerated as candidates.
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.id, /orphan_events/u)
  }
})

test('single chain: one edge, one candidate, admitted', () => {
  const expected = fixture('single-chain').expect
  const { enumerated, result } = runP0P1('single-chain')
  assert.equal(enumerated.candidates.length, expected.candidates)
  assert.equal(result.selected.length, expected.admitted)
})

test('the gate is the engine\'s ordered predicate list, and the pack only narrows it', () => {
  assert.deepEqual(gate([], {}).ordered, DEFAULT_GATE_PREDICATES.map(([label]) => label))
  // CHANGED (t33/t24): the assertion used to require every pack pattern to be
  // one of the engine's defaults, which is exactly backwards for a domain-owned
  // exclusion — a pattern the engine already applies proves nothing about this
  // domain. `**/backfill/**` is declared by the pack and is what makes the
  // all-gated-out boundary hold without the fixture narrowing anything.
  assert.deepEqual(pack.gate.exclude, ['**/.git/**', '**/dist/**', '**/build/**', '**/backfill/**'])
  assert.ok(pack.gate.exclude.includes('**/backfill/**'), 'the domain-owned exclusion must live in the pack')
  assert.ok(!pack.gate.exclude.includes('**/node_modules/**'), 'node_modules is covered by default-path')
  assert.ok(!pack.gate.exclude.includes('**/vendor/**'), 'vendor is covered by default-path')
})

test('the source refuses malformed input instead of returning a silent empty set', () => {
  assert.throws(() => source.enumerate(null, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ nodes: 'nope' }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ nodes: [], schema: [] }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ nodes: [], runs: {} }, {}), /E_INPUT_FORMAT/u)
  // CHANGED (input-format): `schema` is ONE flat map keyed by "db.table". A
  // malformed table definition was read as "no columns", which silently drops
  // the field-level candidates for that chain (16 -> 13) instead of saying so.
  assert.throws(() => source.enumerate({ nodes: [], schema: { 'raw.orders': 'nope' } }, {}), /E_INPUT_FORMAT/u)
  assert.throws(() => source.enumerate({ nodes: [], schema: { 'raw.orders': [] } }, {}), /E_INPUT_FORMAT/u)
  assert.doesNotThrow(() => source.enumerate({ nodes: [], schema: { 'raw.orders': { columns: [] } } }, {}))
  // A missing `nodes` is NOT the same as an empty graph: one is a malformed
  // request, the other is a legitimate "there is nothing here".
  assert.doesNotThrow(() => source.enumerate({ nodes: [] }, {}))
})

test('candidate ids are unique and `path` stays a gate-globable file path', () => {
  const { enumerated } = runP0P1('happy-path')
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const candidate of enumerated.candidates) {
    assert.doesNotMatch(candidate.path, /#/u, 'a synthetic id must never leak into candidate.path')
    assert.match(candidate.path, /^[a-z0-9][a-z0-9._:/-]*$/u, 'the gate cannot glob this path')
    assert.equal(typeof candidate.locator.nodeId, 'string')
  }
})

// ---------------------------------------------------------------------------
// The thing this domain exists for: edges come from the GRAPH, not from SQL
// ---------------------------------------------------------------------------

console.log('\nP0/P5 — the edge is a graph fact, never a SQL regex')

test('an edge is derived from inputs/outputs, not from identifiers found in the SQL', () => {
  const nodes = [
    { id: 'a', inputs: [], outputs: ['raw.one'], path: 'dags/a.sql', sql: 'select * from raw.one' },
    // `raw.decoy` appears in the SQL of `b` but is NOT one of its inputs/outputs.
    { id: 'b', inputs: ['raw.one'], outputs: ['analytics.two'], path: 'dags/b.sql', sql: 'select * from raw.one join raw.decoy on 1 = 1' },
  ]
  const enumerated = source.enumerate({ nodes }, {})
  const ids = enumerated.candidates.map((candidate) => candidate.id)
  assert.ok(ids.includes('b#edge#raw.one->b'), 'the real edge must be enumerated')
  assert.ok(!ids.some((id) => id.includes('raw.decoy')), 'a table named only in SQL must NOT become an edge')
  assert.deepEqual(lineageEdges(nodes).length, 3, 'a(1) + b(2) edges')
})

test('the source and the verifier share ONE edge definition', () => {
  const nodes = [{ id: 'a', inputs: ['raw.one'], outputs: ['analytics.two'] }]
  const edges = lineageEdges(nodes)
  assert.deepEqual(edges, [
    { nodeId: 'a', from: 'raw.one', to: 'a', direction: 'consumed' },
    { nodeId: 'a', from: 'a', to: 'analytics.two', direction: 'produced' },
  ])
  assert.equal(edgeConfirmed(nodes, { nodeId: 'a', from: 'raw.one', to: 'a' }).confirmed, true)
  assert.equal(edgeConfirmed(nodes, { nodeId: 'a', from: 'analytics.two', to: 'a' }).confirmed, false, 'the direction is part of the edge')
  assert.equal(edgeConfirmed(nodes, { nodeId: 'nope', from: 'raw.one', to: 'a' }).node, null)
})

test('the SQL line is carried as EVIDENCE, and a node with no SQL says so', () => {
  const nodes = [
    { id: 'a', inputs: [], outputs: ['raw.one'], path: 'dags/a.sql', sql: 'insert into raw.one\nselect 1' },
    { id: 'b', inputs: ['raw.one'], outputs: [], path: 'dags/b.sql' },
  ]
  const enumerated = source.enumerate({ nodes }, {})
  const edgeA = enumerated.candidates.find((candidate) => candidate.id === 'a#edge#a->raw.one')
  assert.equal(edgeA.text, 'insert into raw.one')
  assert.equal(edgeA.meta.evidenceKind, 'sql-line')
  const edgeB = enumerated.candidates.find((candidate) => candidate.id === 'b#edge#raw.one->b')
  assert.equal(edgeB.meta.evidenceKind, 'graph-only', 'with no SQL there is graph evidence only — and the candidate says so')
  assert.match(edgeB.text, /只有图结构证据/u)
})

// ---------------------------------------------------------------------------
// P2 — bundling via bundleKey
// ---------------------------------------------------------------------------

console.log('\nP2 — bundling by lineage chain')

test('bundleKey is a v2 object whose private strategy supplies its own resolver', () => {
  const declared = pack.bundleKey
  assert.equal(typeof declared, 'object')
  assert.notEqual(declared, null)
  assert.equal(declared.strategy, 'lineage-chain')
  assert.ok(!['path', 'file', 'directory', 'extension'].includes(declared.strategy),
    'a generic strategy would not express "one lineage chain / one table"')
  assert.equal(typeof declared.resolve, 'function', 'a private strategy name must supply bundleKey.resolve')
  // The key the resolver derives is the TABLE, not the path it read.
  assert.equal(declared.resolve({ path: 'models/analytics/orders_daily.sql' }), 'analytics.orders_daily')
  assert.notEqual(declared.resolve({ path: 'models/analytics/orders_daily.sql' }), 'models/analytics/orders_daily.sql')
})

test('two candidates of one chain really land in ONE bundle — including two DIFFERENT scripts', () => {
  const keyed = keyedAdmitted('happy-path')
  assert.ok(keyed.length >= 4, 'bundle() short-circuits below 4 entries; this fixture must be past that')

  const bundled = bundle(keyed)
  const keys = bundled.bundles.map((item) => item.key).sort()
  assert.deepEqual(keys, fixture('happy-path').expect.bundleKeys)
  assert.equal(bundled.bundles.length, fixture('happy-path').expect.bundles)
  assert.equal(bundled.degraded, false)

  // The point of the assertion: candidates that share a CHAIN share a bundle,
  // even when they come from different scripts.
  const byKey = new Map(bundled.bundles.map((item) => [item.key, item.entries]))
  for (const [left, right] of fixture('happy-path').expect.sameBundle) {
    const owner = [...byKey.entries()].find(([, entries]) => entries.some((entry) => entry.id === left))
    assert.ok(owner !== undefined, `${left} must be in some bundle`)
    assert.ok(owner[1].some((entry) => entry.id === right), `${left} and ${right} must share one bundle (got ${owner[0]})`)
  }
  for (const [key, size] of Object.entries(fixture('happy-path').expect.bundleSizes)) {
    assert.equal(byKey.get(key)?.length, size, `bundle ${key} size`)
  }
  const analytics = byKey.get('analytics.orders_daily') ?? []
  const owners = new Set(analytics.map((entry) => entry.locator.nodeId))
  for (const nodeId of fixture('happy-path').expect.separateNodesInOneBundle) {
    assert.ok(owners.has(nodeId), `${nodeId}'s candidates must be in the chain bundle`)
  }

  // The counterfactual the acceptance warns about: one bundle per CANDIDATE
  // (what a strategy that refuses to group degenerates into).
  const naive = bundle(keyed.map((entry) => ({ ...entry, key: entry.id })))
  assert.equal(naive.bundles.length, keyed.length)
  assert.ok(bundled.bundles.length < naive.bundles.length)
})

test('the pack\'s resolver agrees with the source\'s own notion of a chain', () => {
  const { result } = runP0P1('happy-path')
  for (const entry of result.selected) {
    assert.equal(pack.bundleKey.resolve(entry), chainKey(entry))
  }
  const noMeta = { path: 'dags/x.sql' }
  assert.equal(pack.bundleKey.resolve(noMeta), 'dags/x.sql', 'a path outside the convention must not become an invented chain')
})

test('resolveBundleKey reports the resolver as applied/derived for every candidate', () => {
  const { result } = runP0P1('happy-path')
  for (const entry of result.selected) {
    const resolution = resolveBundleKey(pack, entry, {})
    assert.equal(resolution.applied, true)
    assert.equal(resolution.source, 'derived')
    assert.equal(resolution.strategy, 'lineage-chain')
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
      assert.equal(typeof verdict.detail, 'string', 'every unanchored verdict must explain itself')
      if (entry.expectKnownColumns !== undefined) assert.deepEqual(verdict.knownColumns, entry.expectKnownColumns)
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

test('a paraphrase never anchors, even when the identifiers are all real', () => {
  const nodes = [{ id: 'a', inputs: ['raw.one'], outputs: [] }]
  const verdict = anchor.verify(
    { kind: 'lineage-ref', path: 'dags/a.sql', locator: { nodeId: 'a', from: 'raw.one', to: 'a' }, excerpt: 'reads from the raw one table' },
    { path: 'dags/a.sql', content: 'from raw.one\n', lineage: { nodes } },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
})

test('the edge check runs BEFORE the text check: a real line cannot prove a missing edge', () => {
  const nodes = [{ id: 'a', inputs: ['raw.one'], outputs: [] }]
  const subject = { path: 'dags/a.sql', content: 'from raw.one\n', lineage: { nodes } }
  const good = anchor.verify({ kind: 'lineage-ref', path: 'dags/a.sql', locator: { nodeId: 'a', from: 'raw.one', to: 'a' }, excerpt: 'from raw.one' }, subject)
  assert.equal(good.status, 'anchored')
  assert.equal(good.code, 'edge-confirmed')

  const bad = anchor.verify({ kind: 'lineage-ref', path: 'dags/a.sql', locator: { nodeId: 'a', from: 'raw.two', to: 'a' }, excerpt: 'from raw.one' }, subject)
  assert.equal(bad.status, 'unanchored')
  assert.equal(bad.code, 'edge-unconfirmed', 'the same verbatim line must NOT confirm a different edge')
  assert.deepEqual(bad.actualEdges, [{ from: 'raw.one', to: 'a', direction: 'consumed' }])
})

test('without a lineage graph the verifier refuses rather than falling back to SQL text', () => {
  const verdict = anchor.verify(
    { kind: 'lineage-ref', path: 'dags/a.sql', locator: { nodeId: 'a', from: 'raw.one', to: 'a' }, excerpt: 'from raw.one' },
    { path: 'dags/a.sql', content: 'from raw.one\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-documents')
  assert.equal(verdict.code, 'no-lineage')
})

test('a wrong line number is refused rather than repaired', () => {
  const nodes = [{ id: 'a', inputs: ['raw.one'], outputs: [] }]
  const verdict = anchor.verify(
    { kind: 'lineage-ref', path: 'dags/a.sql', locator: { nodeId: 'a', from: 'raw.one', to: 'a', startLine: 99 }, excerpt: 'from raw.one' },
    { path: 'dags/a.sql', content: 'from raw.one\n', lineage: { nodes } },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'locator-mismatch')
})

test('a claim of the wrong kind is refused, not coerced', () => {
  const verdict = anchor.verify(
    { kind: 'diff-line', path: 'dags/a.sql', locator: {}, excerpt: 'from raw.one' },
    { path: 'dags/a.sql', content: 'from raw.one\n' },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'kind-mismatch')
})

test('that refusal NAMES the structured export instead of denying it holds the text', () => {
  // The behaviour pinned below is deliberate. What was not: the refusal said
  // 「与任何可比对文档都不含这段原文」 while the supplied document demonstrably DID
  // contain it. A false reason sends the caller hunting for a typo that is not
  // there; the refusal must name the document, say why it still does not count,
  // and point at the prose that does — the node's own SQL.
  const graphDocument = {
    path: 'lineage/graph.json',
    content: JSON.stringify({ nodes: [{ id: 'a', inputs: [], outputs: ['raw.one'], sql: 'insert into raw.one\nselect 1' }] }),
  }
  const verdict = anchor.verify(
    { kind: 'lineage-ref', path: 'models/x.sql', locator: { nodeId: 'a', from: 'a', to: 'raw.one' }, excerpt: graphDocument.content },
    { path: 'models/x.sql', documents: [graphDocument] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match')
  assert.match(verdict.detail, /lineage\/graph\.json/u, 'the refusal must name the document that holds the text')
  assert.match(verdict.detail, /DATA/u, 'and say why it still does not count as quoted prose')
  assert.match(verdict.detail, /SQL/u, 'and point at what SHOULD be quoted')
})

test('a structured payload document is DATA, not prose: an excerpt never relocates into it', () => {
  const graphDocument = {
    path: 'lineage/graph.json',
    content: JSON.stringify({ nodes: [{ id: 'a', inputs: [], outputs: ['raw.one'] }] }),
  }
  const verdict = anchor.verify(
    { kind: 'lineage-ref', path: 'models/x.sql', locator: { nodeId: 'a', from: 'a', to: 'raw.one' }, excerpt: 'insert into raw.one' },
    { path: 'models/x.sql', documents: [graphDocument] },
  )
  assert.equal(verdict.status, 'unanchored')
  assert.equal(verdict.tier, 'no-match', 'the excerpt must not be "found" inside the graph payload')
})

test('a malformed claim throws E_ANCHOR_CONTRACT rather than returning a guess', () => {
  assert.throws(() => anchor.verify(null, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ path: 'a' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'lineage-ref' }, {}), /E_ANCHOR_CONTRACT/u)
  assert.throws(() => anchor.verify({ kind: 'lineage-ref', path: 'a', locator: 'x' }, {}), /E_ANCHOR_CONTRACT/u)
})

// ---------------------------------------------------------------------------
// P4 / P6 — prompts
// ---------------------------------------------------------------------------

console.log('\nP4/P6 — prompts must not be the same document')

const reviewContext = {
  pack,
  orientation: pack.lossOrientation,
  candidates: ['dags/clean_orders.sql'],
  bundle: { key: 'analytics.orders_daily', paths: ['dags/clean_orders.sql'], rules: ['lineage-edge-declared-not-real'] },
  ruleText: '<rules path="dags/clean_orders.sql">\n血缘边声明与图不符：……\n</rules>',
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
}
const verifyContext = {
  pack,
  orientation: pack.lossOrientation,
  findings: [
    { id: 'f1', path: 'dags/clean_orders.sql', from: 'raw.orders', to: 'clean_orders', evidence: 'from raw.orders', message: '下游仍按非空处理', defended: true },
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
  assert.match(P4.system, /血缘边声明与图不符/u, 'P4 must inject the matched rule text')
  assert.match(P4.system, /500/u, 'P4 must state the read bound')
  assert.doesNotMatch(P6.system, /血缘边声明与图不符/u)
  assert.equal(P4.rules, reviewContext.ruleText)
  assert.deepEqual(P4.budget, reviewContext.budget)
})

test('both prompts carry the domain laws: the edge rule and the quote rule', () => {
  for (const text of [P4.system, P6.system]) {
    assert.match(text, /行号/u)
    assert.match(text, /血缘/u)
  }
  assert.match(P4.system, /不要输出行号|永远不要输出行号/u)
  assert.match(P6.system, /inputs\/outputs/u)
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

const LINEAGE = {
  nodes: [
    { id: 'a', inputs: [], outputs: ['raw.one'] },
    { id: 'b', inputs: ['raw.one'], outputs: ['analytics.two'] },
    { id: 'c', inputs: ['analytics.two'], outputs: ['reporting.three'] },
  ],
  schema: { 'analytics.two': { columns: [{ name: 'id', type: 'text', nullable: false }, { name: 'amount', type: 'numeric', nullable: true }] } },
}
const DOCS = [{ path: 'dags/b.sql', content: 'insert into analytics.two\nselect id, amount\nfrom raw.one\n' }]
const toolByName = (name) => evidence.tools.find((tool) => tool.name === name)

await testAsync('lineage_walk returns the node neighbourhood and caps its edge count', async () => {
  const tool = toolByName('lineage_walk')
  const one = await tool.execute({ nodeId: 'b', depth: 1, lineage: LINEAGE }, {})
  assert.deepEqual(one.items.map((item) => `${item.from}->${item.to}`), ['raw.one->b', 'b->analytics.two'])
  assert.equal(one.truncated, false)
  assert.match(one.provenance, /3 个节点/u)

  const wide = { nodes: [{ id: 'n0', inputs: [], outputs: Array.from({ length: 60 }, (_, index) => `t${index}`) }] }
  const many = await tool.execute({ nodeId: 'n0', depth: 1, lineage: wide }, {})
  assert.ok(many.items.length <= tool.limits.maxItems)
  assert.equal(many.items.length, tool.limits.maxItems)
  assert.equal(many.truncated, true)
})

await testAsync('node_sql_excerpt reads at most its declared maxLines and says when it cut', async () => {
  const tool = toolByName('node_sql_excerpt')
  const big = { path: 'dags/big.sql', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await tool.execute({ path: 'dags/big.sql', start: 1, documents: [big] }, {})
  assert.equal(result.items.length, tool.limits.maxLines)
  assert.equal(result.truncated, true)
  assert.ok(result.provenance.length > 0)
})

await testAsync('column_contract reports the schema and refuses an unknown table loudly', async () => {
  const tool = toolByName('column_contract')
  const result = await tool.execute({ table: 'analytics.two', lineage: LINEAGE }, {})
  assert.deepEqual(result.items.map((item) => item.column), ['id', 'amount'])
  assert.equal(result.truncated, false)
  assert.throws(() => tool.execute({ table: 'nope.nope', lineage: LINEAGE }, {}), /schema 里没有/u)
})

await testAsync('a request with no injected context is refused, not answered with "nothing found"', async () => {
  assert.throws(() => toolByName('lineage_walk').execute({ nodeId: 'a' }, {}), /缺少 `lineage`/u)
  assert.throws(() => toolByName('node_sql_excerpt').execute({ path: 'dags/b.sql' }, {}), /缺少 `documents`/u)
  assert.throws(() => toolByName('node_sql_excerpt').execute({ path: 'dags/none.sql', documents: DOCS }, {}), /文档集里没有/u)
})

test('the registered tool name is the contract\'s derived name', () => {
  assert.equal(evidenceToolName('data-engineering', 'lineage_walk'), 'adjudicate_data_engineering_evidence_lineage_walk')
})

// ---------------------------------------------------------------------------
// P6/P7 — loss, coverage, report
// ---------------------------------------------------------------------------

console.log('\nP6/P7 — findings, coverage and the report')

test('the coverage rate is computed from the finding paths, not asserted', () => {
  const proof = coverage(12, [{ path: 'a' }, { path: 'b' }, { path: 'a' }])
  assert.equal(proof.total, 12)
  assert.equal(proof.reviewed, 2, 'distinct paths, not finding count')
  assert.equal(proof.coverageRate, Number((2 / 12).toFixed(4)))
  assert.equal(proof.complete, false)
})

test('recall-first keeps what it cannot disprove and drops only what is disproved', () => {
  const panel = runCritiquePanel([
    { id: 'suspicion', path: 'dags/a.sql', severity: 'low', evidence: '' },
    { id: 'supported', path: 'dags/a.sql', severity: 'high', evidence: 'x', defended: true },
    { id: 'refuted', path: 'dags/b.sql', severity: 'high', evidence: 'x', defended: true, disproved: true },
  ], { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  assert.deepEqual(panel.kept.map((finding) => finding.id), ['suspicion', 'supported'])
  assert.deepEqual(panel.dropped.map((item) => item.id), ['refuted'])
  assert.equal(panel.kind, 'triage')
  assert.equal(panel.orientation, 'recall-first')
})

test('the report carries the domain, the orientation, the criticism kind and the recall-first requirement', () => {
  const panel = runCritiquePanel([{ id: 'f', path: 'dags/a.sql', severity: 'high', evidence: 'x', defended: true }],
    { orientation: pack.lossOrientation, kind: pack.criticism.kind })
  const built = report({
    domain: pack,
    target: 'fixture',
    scope: { admitted: 12, excluded: 0, bundles: 3 },
    findings: panel.kept,
    coverageProof: coverage(12, panel.kept, { requireComplete: true }),
    budget: createBudget({}),
    critiqueResult: panel,
  })
  assert.equal(built.domain, 'data-engineering')
  assert.equal(built.lossOrientation, 'recall-first')
  assert.equal(built.criticismKind, 'triage')
  assert.equal(built.coverage.total, 12)
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
  const loaded = await loadDomain(io, { id: 'data-engineering', dir: 'domains/data-engineering' })
  assert.deepEqual(loaded.problems, [], loaded.problems.join('; '))
  const assembled = loaded.pack
  assert.deepEqual(validateDomainPackV2(assembled), [])
  assert.equal(assembled.candidateSource.kind, 'lineage-edges-and-columns')
  assert.equal(assembled.anchorVerifier.kind, 'lineage-ref')
  assert.equal(assembled.evidenceTools.tools.length, evidence.tools.length)
  assert.equal(typeof assembled.reviewPrompts.review, 'function')
  assert.equal(typeof assembled.reviewPrompts.verify, 'function')
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

const planFor = async (ctx, name) => {
  const value = fixture(name)
  return ctx.__tools.get('adjudication_plan').execute({
    domain: 'data-engineering',
    target: `fixture ${name}`,
    input: { format: value.input.format, payload: value.input.payload },
  }, {})
}

await testAsync('adjudication_plan consumes the lineage export through the pack candidateSource', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await planFor(ctx, 'happy-path')

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'lineage-edges-and-columns')
  assert.equal(plan.candidateSet.inputFormat, 'lineage-and-schema')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.candidateSet.excludedBySource.length, happy.expect.sourceExcluded)
  // The chain-artifact convention is stated in the plan, not left implicit.
  assert.ok(plan.candidateSet.notes.some((note) => /链的模型文件/u.test(note)), 'the path convention must be reported')
  assert.equal(plan.gate.excluded.length, 0)
  assert.equal(plan.gate.admitted, happy.expect.admitted)
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.strategy, 'lineage-chain')
  assert.equal(plan.bundleKey.derived, happy.expect.admitted)
  assert.equal(plan.bundles.length, happy.expect.bundles)
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), happy.expect.bundleKeys)
  // The plan's own view of the bundles: the chain key, and the candidate count
  // behind it (the engine reports one path per entry, which is why a chain with
  // 8 candidates shows 8 identical paths).
  const byKey = new Map(plan.bundles.map((item) => [item.key, item]))
  for (const [key, size] of Object.entries(happy.expect.bundleSizes)) {
    assert.equal(byKey.get(key)?.paths.length, size, `bundle ${key} holds ${size} candidates`)
  }
  assert.equal(byKey.get('analytics.orders_daily').paths.every((path) => path === 'models/analytics/orders_daily.sql'), true,
    'the whole chain is reviewed as one artifact')
  assert.equal(plan.criticism.kind, 'triage')
  assert.match(plan.summary, /复核者：triage/u)
  for (const bundle of plan.bundles) {
    assert.ok(bundle.rules.length > 0, `bundle ${bundle.key} got no rules — the rule library is not wired to the plan`)
  }
})

await testAsync('the plan over the empty fixture says "this is itself the conclusion"', async () => {
  const ctx = createPluginContext()
  const plan = await planFor(ctx, 'empty')
  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /不要凭空审核/u)
  assert.equal(plan.bundleKey.applied, false)
  assert.match(plan.bundleKey.reason, /没有准入候选/u)
})

await testAsync('the plan over the all-gated-out fixture reports every gate reason — on the PACK gate alone', async () => {
  const ctx = createPluginContext()
  // CHANGED (t33/t24): this test used to assert `admitted: 2` and explain the
  // gap in a comment, because the fixture's own `maxFileBytes` narrowing never
  // reached the plugin. That gap is the defect this fixes: the boundary must
  // hold through the REAL plan, with NOTHING but the pack's own gate applying,
  // and every excluded path must name the predicate that fired. The fixture no
  // longer carries a `gate` block at all.
  assert.equal(fixture('all-gated-out').gate, undefined, 'the fixture must not declare a gate any more')
  const plan = await planFor(ctx, 'all-gated-out')
  const predicates = {}
  for (const item of plan.gate.excluded) {
    assert.ok(typeof item.predicate === 'string' && item.predicate.length > 0, `excluded "${item.path}" names no predicate`)
    assert.ok(typeof item.reason === 'string' && item.reason.length > 0, `excluded "${item.path}" carries no reason`)
    ;(predicates[item.predicate] ??= []).push(item.path)
  }
  for (const key of Object.keys(predicates)) predicates[key].sort()
  assert.deepEqual(predicates, fixture('all-gated-out').expect.excludedByPredicate)
  assert.equal(plan.gate.admitted, 0)
  assert.equal(plan.bundles.length, 0)
  assert.match(plan.summary, /准入 0 项/u)
  assert.match(plan.summary, /排除 8 项/u)
})

/**
 * The document set a reviewer must hand back: the SQL that is the evidence for
 * each chain, PLUS the lineage export itself under the domain's convention
 * (`lineage/graph.json`). The engine's recompute path can only pass a verifier
 * `{path, content, document, documents}`, so the graph travels as a document —
 * which also means the graph being checked is the one the plan was given.
 */
function documentsFor(name) {
  const payload = fixture(name).input.payload
  const documents = []
  const seen = new Set()
  for (const node of payload.nodes) {
    const table = Array.isArray(node.outputs) && node.outputs.length === 1 ? node.outputs[0] : null
    if (table === null) continue
    const path = `models/${table.toLowerCase().split('.').join('/')}.sql`
    if (seen.has(path)) continue
    seen.add(path)
    documents.push({ path, content: node.sql })
  }
  documents.push({ path: 'lineage/graph.json', content: JSON.stringify({ nodes: payload.nodes, schema: payload.schema ?? null }) })
  return documents
}

await testAsync('P0 -> P5 -> P7 round trip: the ENGINE recomputes every anchor, and coverage is real', async () => {
  const ctx = createPluginContext()
  const happy = fixture('happy-path')
  const plan = await planFor(ctx, 'happy-path')
  const documents = documentsFor('happy-path')

  // Four claims: three real anchors and one deliberate paraphrase. Which ones
  // survive is decided by the domain verifier inside the engine, never by this
  // file — the findings below carry a `locator` and an `excerpt`, and nothing
  // else is claimed about their location.
  const findings = [
    { id: 'f1', severity: 'high', message: '清洗节点读的表与图上不一致', evidence: 'from raw.orders', path: 'models/analytics/orders_daily.sql', locator: { nodeId: 'clean_orders', from: 'raw.orders', to: 'clean_orders' } },
    { id: 'f2', severity: 'medium', message: '报表节点依赖的日表没有分区过滤', evidence: 'from analytics.orders_daily', path: 'models/reporting/orders_summary.sql', locator: { nodeId: 'orders_report', from: 'analytics.orders_daily', to: 'orders_report' } },
    { id: 'f3', severity: 'medium', message: '入湖节点的落库语句不可重跑', evidence: 'insert into raw.orders', path: 'models/raw/orders.sql', locator: { nodeId: 'orders_stream', from: 'orders_stream', to: 'raw.orders' } },
    { id: 'f4', severity: 'high', message: '转述出来的断言', evidence: 'the daily table is read without a date filter', path: 'models/reporting/orders_summary.sql', locator: { nodeId: 'orders_report', from: 'analytics.orders_daily', to: 'orders_report' } },
  ]

  // The plugin's own anchor surface routes through the domain verifier. Without
  // a locator it can only confirm the CHAIN, and it says so.
  const viaTool = await ctx.__tools.get('adjudication_anchor').execute(
    { domain: 'data-engineering', excerpt: 'from raw.orders', path: 'models/analytics/orders_daily.sql', documents }, {},
  )
  assert.equal(viaTool.via, 'anchorVerifier')
  assert.equal(viaTool.status, 'anchored')
  assert.equal(viaTool.code, 'chain-confirmed')
  assert.match(viaTool.detail, /边未确认/u)
  assert.equal(viaTool.start, 3)

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'data-engineering',
    target: 'fixture happy-path',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    documents,
    findings,
  }, {})

  // The engine refused the paraphrase, not this file.
  assert.equal(submitted.unanchored, 1)
  assert.equal(submitted.findings.length, 3, 'recall-first keeps every finding the engine could anchor')
  assert.equal(submitted.anchored, undefined, 'the engine does not echo a caller-supplied anchor flag')
  // total is the real admitted count — never inflated to make the rate look good.
  assert.equal(submitted.coverage.total, plan.gate.admitted)
  assert.equal(submitted.coverage.total, happy.expect.admitted)
  assert.equal(submitted.coverage.reviewed, 3, 'three distinct chain artifacts were reviewed')
  assert.ok(Number.isInteger(submitted.coverage.reviewed) && submitted.coverage.reviewed > 0, 'reviewed must be an exact count, not a bound')
  assert.equal(submitted.coverage.coverageRate, Number((submitted.coverage.reviewed / submitted.coverage.total).toFixed(4)), 'the rate is exactly reviewed/total, not an upper bound')
  assert.equal(submitted.coverage.coverageRate, Number((3 / happy.expect.admitted).toFixed(4)))
  assert.equal(submitted.coverage.complete, false)
  assert.equal(submitted.coverage.required, true, 'this domain is recall-first, so completeness is required')
  assert.equal(submitted.criticismKind, 'triage')
  assert.match(submitted.summary, /自报的 anchored\/start 一律不采信/u)
  assert.match(submitted.summary, /未通过/u, 'recall-first + incomplete coverage must be reported as a failure, not a percentage')
  assert.match(submitted.summary, /recall-first/u)
})

await testAsync('the complete-coverage branch: one candidate, one path, no 未通过', async () => {
  const ctx = createPluginContext()
  const single = fixture('single-chain')
  const node = single.input.payload.nodes[0]
  const plan = await planFor(ctx, 'single-chain')
  assert.equal(plan.gate.admitted, 1)
  assert.equal(plan.bundles[0].key, 'raw.events')

  const documents = documentsFor('single-chain')
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'data-engineering',
    target: 'fixture single-chain',
    total: plan.gate.admitted,
    admitted: plan.gate.admitted,
    bundles: plan.bundles.length,
    documents,
    findings: [{
      id: 'f1',
      severity: 'high',
      message: '落库不可重跑',
      evidence: 'insert into raw.events',
      path: 'models/raw/events.sql',
      locator: { nodeId: node.id, from: node.id, to: node.outputs[0] },
    }],
  }, {})

  assert.equal(submitted.unanchored, 0)
  assert.equal(submitted.coverage.total, 1)
  assert.equal(submitted.coverage.reviewed, 1)
  assert.equal(submitted.coverage.coverageRate, 1)
  assert.equal(submitted.coverage.complete, true)
  assert.doesNotMatch(submitted.summary, /未通过/u, 'complete coverage must not be reported as a failure')
  assert.equal(submitted.criticismKind, 'triage')
})

await testAsync('activation registers the domain\'s bounded evidence tools on demand', async () => {
  const ctx = createPluginContext()
  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'data-engineering' }, {})
  assert.equal(activated.ok, true)
  for (const tool of evidence.tools) {
    assert.ok(ctx.__tools.has(evidenceToolName('data-engineering', tool.name)), `${tool.name} must be registered on activation`)
  }
  const registered = ctx.__tools.get(evidenceToolName('data-engineering', 'node_sql_excerpt'))
  const big = { path: 'dags/big.sql', content: Array.from({ length: 900 }, (_, index) => `l${index + 1}`).join('\n') }
  const result = await registered.execute({ path: 'dags/big.sql', documents: [big] }, {})
  assert.equal(result.truncated, true)
  assert.ok(result.items.length <= 120)
  assert.equal(result.domain, 'data-engineering')
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'data-engineering' }, {})
  for (const tool of evidence.tools) {
    assert.equal(ctx.__tools.has(evidenceToolName('data-engineering', tool.name)), false)
  }
})

await testAsync('the domain rules tool reports the v2 library and its provenance warning', async () => {
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'data-engineering' }, {})
  const listed = await ctx.__tools.get('adjudicate_data_engineering_rules').execute({}, {})
  assert.ok(listed.rules.length >= MIN_RULES_PER_DOMAIN, `${listed.rules.length} rules`)
  assert.match(listed.summary, /未经领域专家审定/u)
  assert.match(listed.summary, /needs-expert-review/u)
})

await testAsync('the loaded directory pack replaces the built-in pack of the same id', async () => {
  const ctx = createPluginContext()
  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'data-engineering',
    target: 'replacement probe',
    candidates: [
      { path: 'models/analytics/orders_daily.sql' },
      { path: 'models/analytics/orders_daily.sql' },
      { path: 'models/raw/orders.sql' },
      { path: 'models/raw/orders.sql' },
    ],
  }, {})
  // The v2 object form always applies, and the key is the table the path names.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.deepEqual(plan.bundles.map((item) => item.key).sort(), ['analytics.orders_daily', 'raw.orders'])
  assert.equal(plan.bundles.length, 2, 'four candidates that belong to two chains must not become four bundles')
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19, 'replacement must not change the domain count')
  assert.ok(listed.directory.replaced.includes('data-engineering'), 'the v1 pack must be displaced')
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

await testAsync('all 7 positive anchor cases anchor through the REAL adjudication_anchor (7/7)', async () => {
  const ctx = createPluginContext()
  const cases = fixture('happy-path').anchors.positive
  assert.equal(cases.length, 7, 'the reachability baseline t21 measured is this many positive cases')
  const failures = []
  let anchored = 0
  for (const entry of cases) {
    const result = await viaRealAnchor(ctx, 'data-engineering', entry)
    assert.equal(result.via, 'anchorVerifier', `领域验证器没跑（引擎兜底了）：${entry.note}`)
    if (result.status === 'anchored') { anchored += 1; continue }
    failures.push(`${entry.note} -> ${result.tier}/${result.code}`)
  }
  assert.deepEqual(failures, [], `未锚定：${failures.join(' | ')}`)
  assert.equal(anchored, 7)
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
  assert.ok(checked >= 15, `only ${checked} anchor cases were checked`)
})

await testAsync('every negative case is refused through the REAL tool with the same tier as direct verify', async () => {
  const ctx = createPluginContext()
  let refused = 0
  let kindMismatchCases = 0
  for (const [name, value] of FIXTURES) {
    for (const entry of value.anchors.negative ?? []) {
      if (entry.claim.kind !== anchor.kind) kindMismatchCases += 1
      const result = await viaRealAnchor(ctx, 'data-engineering', entry)
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
      const result = await viaRealAnchor(ctx, 'data-engineering', entry)
      assert.equal(result.via, 'anchorVerifier', `[${name}] ${entry.note}`)
      assert.equal(result.status, 'unanchored', `[${name}] ${entry.note}`)
      assert.equal(result.tier, entry.expectTier, `[${name}] ${entry.note}`)
      assert.ok(Array.isArray(result.ambiguousIn) && result.ambiguousIn.length > 1, `[${name}] 歧义必须列出全部竞争位置`)
      checked += 1
    }
  }
  assert.ok(checked >= 2, `only ${checked} ambiguous cases were routed`)
})

await testAsync('the self-folded payload is still FULLY recomputed: a graph without the claimed edge is refused', async () => {
  // The anti-forgery proof: the self-folded subject is not a structure the
  // verifier can skip over. Take a positive case, keep its subject shape
  // byte-for-byte, and only make the payload DISAGREE — the verdict must flip.
  const entry = fixture('happy-path').anchors.positive[0]
  const subject = strippedSubject(entry.subject)
  assert.equal(anchor.verify(entry.claim, subject).status, 'anchored', 'the untouched self-folded subject must anchor first')
  const data = JSON.parse(subject.content)
  data.nodes = data.nodes.filter((node) => node.id !== 'clean_orders')
  const text = JSON.stringify(data)
  const tampered = {
    path: subject.path,
    content: text,
    documents: (subject.documents ?? []).map((document) => (document.path === subject.path ? { path: document.path, content: text } : { path: document.path, content: document.content })),
  }
  const verdict = anchor.verify(entry.claim, tampered)
  assert.equal(verdict.status, 'unanchored', 'a graph that no longer contains the edge cannot anchor it')
  assert.equal(verdict.code, 'unknown-node')
})

// ---------------------------------------------------------------------------
// t33/t24 — the pack owns its boundary, the interface is real, the bound is reached
// ---------------------------------------------------------------------------

console.log('\nt33/t24 — pack-owned boundary, published interface, reached bound')

test('no fixture narrows the gate: the all-gated-out boundary belongs to the pack', () => {
  // The defect (t24-F1 / the §1.4 audit): this domain reached `admitted: 0`
  // through `"gate": {"maxFileBytes": 200}` — a field the pack's gate does not
  // have, which `adjudication_plan` cannot pass at all. A directory-level scan is
  // the only form that cannot be defeated by adding one more fixture.
  for (const file of FIXTURE_FILES) {
    const raw = JSON.parse(readFileSync(join(here, 'fixtures', file), 'utf8'))
    assert.ok(!Object.hasOwn(raw, 'gate'), `${file} declares a gate block — that is the fixture's rule, not the pack's`)
  }
  const text = FIXTURE_FILES.map((file) => readFileSync(join(here, 'fixtures', file), 'utf8')).join('\n')
  assert.ok(!/"gate"\s*:/u.test(text), 'no fixture may declare a gate block')
  // Key form, not the bare word: prose that EXPLAINS the removed defect is
  // allowed (and is the reason a reader learns why the block is gone), while a
  // fixture that brings the narrowing back is not.
  assert.ok(!/"maxFileBytes"\s*:/u.test(text), 'no fixture may carry maxFileBytes: the pack has no such field')
  assert.ok(!/"exclude"\s*:/u.test(text), 'no fixture may carry a gate exclude list')
  assert.ok(!/"extensions"\s*:/u.test(text), 'no fixture may carry a gate extension list')
  assert.ok(pack.gate.exclude.includes('**/backfill/**'), 'the exclusion the boundary needs is declared by the pack')
})

const rulesForPath = async (ctx, path) => {
  const result = await ctx.__tools.get('adjudicate_data_engineering_plan').execute({
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
  // and a DIRECTORY glob covers its whole subtree. Same `.yaml`, two answers:
  // under `dags/` it is inside the rule globs, elsewhere only the generic
  // fallback applies. The table below is the measurement, through the real plan.
  const ctx = createPluginContext()
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'data-engineering' }, {})
  // pinned numbers: changing them means changing what this domain supports.
  // Order = `[...pack.gate.extensions].sort()`, so a new declaration shows up as
  // a missing row rather than as a silently unmeasured extension.
  const TABLE = [
    { extension: '.ipynb', inside: 'dags/pipeline.ipynb', outside: 'warehouse/notes.ipynb', insideRules: 5, outsideRules: 1 },
    { extension: '.jinja', inside: 'dags/pipeline.jinja', outside: 'warehouse/notes.jinja', insideRules: 5, outsideRules: 1 },
    { extension: '.json', inside: 'dags/pipeline.json', outside: 'warehouse/notes.json', insideRules: 5, outsideRules: 1 },
    { extension: '.md', inside: 'dags/pipeline.md', outside: 'warehouse/notes.md', insideRules: 5, outsideRules: 1 },
    { extension: '.py', inside: 'dags/pipeline.py', outside: 'warehouse/notes.py', insideRules: 5, outsideRules: 5 },
    { extension: '.sql', inside: 'dags/pipeline.sql', outside: 'warehouse/notes.sql', insideRules: 24, outsideRules: 20 },
    { extension: '.yaml', inside: 'dags/pipeline.yaml', outside: 'warehouse/notes.yaml', insideRules: 5, outsideRules: 5 },
    { extension: '.yml', inside: 'dags/pipeline.yml', outside: 'warehouse/notes.yml', insideRules: 5, outsideRules: 5 },
  ]
  assert.deepEqual(TABLE.map((row) => row.extension), [...(pack.gate.extensions ?? [])].sort(),
    'every declared extension needs a row — a new declaration must come with its measurement')
  for (const row of TABLE) {
    const inside = await rulesForPath(ctx, row.inside)
    const outside = await rulesForPath(ctx, row.outside)
    assert.equal(inside.admitted, 1, `${row.inside} must be admitted (the question is what it gets, not whether it passes)`)
    assert.equal(outside.admitted, 1, `${row.outside} must be admitted`)
    assert.equal(inside.rules, row.insideRules, `${row.extension} under dags/ got ${inside.rules} rules`)
    assert.equal(outside.rules, row.outsideRules, `${row.extension} outside the rule subtrees got ${outside.rules} rules`)
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
    const planned = await ctx.__tools.get('adjudicate_data_engineering_plan').execute({
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
  nodeId: 'b',
  depth: 1,
  lineage: LINEAGE,
  documents: DOCS,
  path: 'dags/b.sql',
  start: 1,
  end: 3,
  table: 'analytics.two',
  column: 'id',
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

const BIG_LINEAGE = {
  nodes: [
    { id: 'n0', inputs: [], outputs: Array.from({ length: 200 }, (_, index) => `wide.t${index}`) },
    { id: 'big', inputs: [], outputs: ['raw.big'] },
  ],
  schema: { 'raw.big': { columns: Array.from({ length: 200 }, (_, index) => ({ name: `c${index}`, type: 'text', nullable: true })) } },
}
const BIG_CONTEXT = {
  lineage_walk: { nodeId: 'n0', depth: 1, lineage: BIG_LINEAGE },
  node_sql_excerpt: { path: 'dags/big.sql', start: 1, documents: [{ path: 'dags/big.sql', content: Array.from({ length: 900 }, (_, index) => `line ${index + 1}`).join('\n') }] },
  column_contract: { table: 'raw.big', lineage: BIG_LINEAGE },
}
const SINGLE_ITEM_BY_CONSTRUCTION = {}

await testAsync('every tool that declares an item bound has a case that REACHES it (t33/t24-F3)', async () => {
  // t24-F3: only one tool here had a truncation case, so growing `maxItems` 500x
  // left the suite green. Each tool now has an over-limit input; the assertion is
  // the exact count, not a bound.
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
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'data-engineering' }, {})
  const name = 'adjudicate_data_engineering_evidence_column_contract'
  const args = { table: 'analytics.two', column: 'id', lineage: LINEAGE }
  const maxCalls = evidence.tools.find((tool) => tool.name === 'column_contract').limits.maxCalls
  for (let call = 1; call <= maxCalls; call += 1) await ctx.__tools.get(name).execute(args, {})
  await assert.rejects(() => ctx.__tools.get(name).execute(args, {}), (error) => new RegExp(`maxCalls=${maxCalls}`, 'u').test(String(error?.message ?? error)))
  // A fresh activation starts a fresh budget: one run must not poison the tool.
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'data-engineering' }, {})
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'data-engineering' }, {})
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
