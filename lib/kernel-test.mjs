/**
 * Kernel test — `node lib/kernel-test.mjs`. No framework, no dependencies.
 *
 * This is the contract-v2 RUNTIME proof. `contract-test.mjs` proves the shapes;
 * this file proves the machinery that consumes them:
 *
 *   1. runtime validation for all five extension points — illegal input is
 *      rejected with a readable, actionable reason;
 *   2. `domains/<id>/` discovery: found, skipped-on-invalid, duplicate-rejected;
 *   3. the nineteen inline packs still work unchanged (19 domains, 43 + 13
 *      existing assertions untouched);
 *   4. `bundleKey` really participates in bundling;
 *   5. `candidateSet` and `criticism.kind` are actually read by the engine;
 *   6. the P4 executor: optional injection, budget, cancellation, degradation.
 *
 * It runs the plugin through a mock Cordis context that can mount optional
 * services, and drives the domain loader through an in-memory io — so the whole
 * discovery path is exercised without creating a single file on disk.
 *
 * ONE RULE FOR ANYONE ADDING A TEST HERE (t4)
 * -------------------------------------------
 * `apply(ctx, {})` reads the REAL `domains/` directory (`options.domainIo ??
 * createNodeIo(...)`). So a test that means to assert something about the
 * BUILT-IN library must pass `EMPTY_DOMAIN_IO`; otherwise the moment a domain
 * ships as a v2 directory package, that test silently starts measuring the
 * domain instead of the library — same assertion, different subject. Tests that
 * MEAN to exercise discovery pass an io with content (see `domainFiles`), and
 * section 2 does exactly that.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, DEFAULT_OPTIONS, CORE_TOOL_NAMES } from '../index.js'
import { RECALL_FIRST_DOMAINS } from './domains.js'
import { createRegistry, domainToolNames } from './registry.js'
import {
  createMemoryIo,
  createNodeIo,
  discoverDomains,
  loadDomain,
  loadDomains,
  registerLoadedDomains,
  SKIPPED_ENTRY_KEYS,
  validateSkippedEntries,
  validateSkippedEntry,
} from './domain-loader.js'
import { createReasoner, describeReasoner, extractFindings, extractVerdicts, extractVerdictsDetailed, renderReviewPrompt, renderVerifyPrompt, REASONER_CODES } from './reasoner.js'
import {
  CONTRACT_VERSION,
  ERROR_CODES,
  ANCHOR_TIERS,
  PROMPT_CONTEXT_FIELDS,
  TRUSTED_ANCHOR_TIERS,
  createAnchorClaim,
  defineAnchorVerifier,
  defineCandidateSource,
  defineDomainPackV2,
  defineEvidenceToolkit,
  defineReviewPrompts,
  defineRuleLibrary,
  normaliseEvidenceLimits,
  validateAnchorVerdict,
  validateCandidateSetResult,
  validateDomainPackV2,
  validateEvidenceResult,
  validateEvidenceTool,
  validatePromptOutput,
  validateRuleDocument,
  resolveBundleKey,
  rulesOf,
} from './contracts.js'
import { selectRules, normalizeLine, anchorInDocument, resolveAnchor, validatedEngineVerdict } from './engine.js'

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

async function testAsync(title, body) {
  try {
    await body()
    passes += 1
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${title}`)
    console.log(`       ${error.message}`)
  }
}

/**
 * An io that contains NO domain directory. (t4)
 *
 * Every test that asserts something about the BUILT-IN library — its size, the
 * plugin's own tool surface, a v1 pack's declaration — must pass this, because
 * the default (`options.domainIo ?? createNodeIo(...)`) reads the real
 * `domains/` directory. With `domains/code-review/` present, a test that
 * forgets this stops measuring the built-in library and starts measuring the
 * reference domain, which is a different question asked under the same name.
 *
 * This is not a shortcut to make assertions pass: a test that means to exercise
 * discovery passes an io WITH content (see `domainFiles`), and section 2 loads
 * real directory packs through exactly that path.
 */
const EMPTY_DOMAIN_IO = Object.freeze({ domainIo: createMemoryIo({}) })

// ---------------------------------------------------------------------------
// Mock Cordis context — same surface `apply()` uses, plus optional services
// ---------------------------------------------------------------------------

function createContext(services = {}) {
  const tools = new Map()
  const effects = []
  const sections = []
  const injectedNames = []
  const registered = new Map()

  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },

    effect(callback, label) {
      const entry = { label, dispose: undefined, undone: false }
      if (typeof callback === 'function' && callback.constructor?.name === 'GeneratorFunction') {
        const iterator = callback()
        const produced = []
        let step = iterator.next()
        while (step.done !== true) {
          if (typeof step.value === 'function') produced.push(step.value)
          step = iterator.next()
        }
        entry.dispose = () => { for (const dispose of produced.reverse()) dispose() }
      } else {
        const disposer = callback()
        if (typeof disposer === 'function') entry.dispose = disposer
      }
      effects.push(entry)
      return () => {
        if (entry.undone) return
        entry.undone = true
        entry.dispose?.()
      }
    },

    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name) => tools.get(name),
      names: () => [...tools.keys()],
    },

    inject(names, callback) {
      injectedNames.push(names)
      const mounted = {}
      for (const name of names) {
        if (services[name] === undefined) return
        mounted[name] = services[name]
      }
      callback({ ...mounted, effect: (fn, label) => ctx.effect(fn, label) })
    },

    provide(key, value) { registered.set(key, value) },
    set(key, value) { registered.set(key, value) },
    get: (key) => registered.get(key),

    __tools: tools,
    __effects: effects,
    __sections: sections,
    __injectedNames: injectedNames,
    __registered: registered,
  }
  return ctx
}

const PROMPT_SERVICE = {
  systemPrompt: { section: (spec) => 0 },
}

// ---------------------------------------------------------------------------
// Domain-directory fixtures, built entirely in memory
// ---------------------------------------------------------------------------

const RULE_TEXT = '规则正文：这条书面规范必须足够长，才能构成一条真正的规则正文。'

function ruleDocument(name) {
  return [
    '---',
    `name: ${name}`,
    'match:',
    '  - "**/*.ts"',
    '  - "**/*.json"',
    'needs-expert-review: true',
    '---',
    RULE_TEXT,
  ].join('\n')
}

function ruleFiles(directory) {
  const files = {}
  for (let index = 0; index < 20; index += 1) {
    const name = `rule-${String(index).padStart(2, '0')}`
    files[`${directory}/rules/${name}.md`] = ruleDocument(name)
  }
  return files
}

/** Build a complete, valid v2 domain directory. */
function domainFiles(directory, id, overrides = {}) {
  const pack = {
    contractVersion: 2,
    id,
    title: `演示领域 ${id}`,
    category: 'A',
    lossOrientation: 'precision-first',
    anchor: { kind: `${id}-anchor`, verify: 'engine-recomputable' },
    candidateSet: { kind: `${id}-candidates`, inputFormat: 'demo-input', description: '演示输入' },
    criticism: { kind: 'fact-checker' },
    bundleKey: { strategy: 'directory', depth: 1 },
    fixtures: ['empty', 'all-gated-out', 'happy-path'],
    ...overrides.pack,
  }

  const modules = {
    [`${directory}/index.js`]: { default: pack },
    [`${directory}/source.js`]: {
      default: {
        __contract: CONTRACT_VERSION,
        kind: `${id}-candidates`,
        inputFormat: 'demo-input',
        bounded: true,
        enumerate: (input) => ({
          candidates: (input?.items ?? []).map((item, index) => ({
            id: `${id}-${index}`,
            path: item.path,
            locator: { index },
            text: item.text ?? 'evidence',
            ...(item.key === undefined ? {} : { key: item.key }),
          })),
          excluded: [],
          notes: [],
          bounded: true,
          truncated: false,
        }),
      },
    },
    [`${directory}/anchor.js`]: {
      default: {
        __contract: CONTRACT_VERSION,
        kind: `${id}-anchor`,
        // CHANGED (t17): a real, content-checking verifier instead of the old
        // `locator.index === 0` stub. The F3 regression tests below need a
        // verifier whose verdict actually depends on the documents it is given —
        // otherwise "the engine called the domain verifier" and "the engine
        // believed the caller" would be indistinguishable.
        verify: (claim, subject) => {
          const content = typeof subject?.content === 'string' ? subject.content : ''
          const excerpt = String(claim?.excerpt ?? '')
          if (excerpt === '' || content === '') {
            return { status: 'unanchored', tier: 'no-match', path: null, start: null, end: null, detail: '演示验证器：缺少可核验的原文或文档' }
          }
          const lines = content.split('\n')
          const declared = claim?.locator?.startLine
          if (Number.isInteger(declared) && declared >= 1 && lines[declared - 1] === excerpt) {
            return { status: 'anchored', tier: 'declared-locator', path: claim.path, start: declared, end: declared, detail: '演示验证器：声明行号确认' }
          }
          const hits = []
          for (const [index, line] of lines.entries()) if (line === excerpt) hits.push(index + 1)
          if (hits.length === 1) {
            return { status: 'anchored', tier: 'recomputed-unique', path: claim.path, start: hits[0], end: hits[0], detail: '演示验证器：唯一命中' }
          }
          return {
            status: 'unanchored',
            tier: hits.length === 0 ? 'no-match' : 'relocation-ambiguous',
            path: null,
            start: null,
            end: null,
            detail: `演示验证器：原文命中 ${hits.length} 处`,
          }
        },
      },
    },
    [`${directory}/evidence.js`]: {
      default: {
        __contract: CONTRACT_VERSION,
        tools: [{
          name: 'peek',
          description: '偷看一条候选',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'object' } },
          limits: { maxLines: 10, maxItems: 5 },
          execute: () => ({ items: [{ line: 'x' }], truncated: false, provenance: 'demo' }),
        }],
      },
    },
    [`${directory}/prompts.js`]: {
      default: {
        __contract: CONTRACT_VERSION,
        review: () => ({ system: 'P4 有界评审提示词', rules: 'rule text' }),
        verify: () => ({ system: 'P6 独立复核提示词', instructions: '只看证据' }),
      },
    },
    ...ruleFiles(directory),
  }
  return modules
}

function mergeFiles(...maps) {
  return Object.assign({}, ...maps)
}

/** Module loader for memory io — keyed by the path the io produced. */
function stubLoader(modules) {
  return async (url) => {
    const key = String(url).replace(/^memory:\/\/\//u, '')
    if (modules[key] === undefined) throw new Error(`no such module: ${key}`)
    return modules[key]
  }
}

console.log(`\ndsh-adjudication contract-v2 kernel test\n${'='.repeat(54)}\n`)

// ---------------------------------------------------------------------------
console.log('1. runtime validation for the five extension points')
// ---------------------------------------------------------------------------

test('a malformed candidateSource is refused at definition time with a readable reason', () => {
  assert.deepEqual(defineCandidateSource({ kind: 'x', enumerate: () => ({}) }).kind, 'x')
  assert.throws(
    () => defineCandidateSource({ kind: 'x' }),
    (error) => error.name === 'DomainContractError'
      && error.code === ERROR_CODES.E_CONTRACT
      && /enumerate must be a function/u.test(error.message),
  )
  assert.throws(() => defineEvidenceToolkit({ tools: [{ name: 'Bad Name', description: 'd', parameters: {}, output: { schema: {} }, limits: { maxLines: 1 }, execute: () => {} }] }),
    /snake_case/u)
  assert.throws(() => defineAnchorVerifier({ kind: 'x' }), /verify must be a function/u)
  assert.throws(() => defineReviewPrompts({ review: () => ({}) }), /verify must be a function/u)
  assert.throws(() => defineRuleLibrary({ rules: [] }), /at least 20/u)
})

test('an evidence tool without limits can never be defined', () => {
  const problems = validateEvidenceTool({ name: 'peek', description: 'd', parameters: {}, output: { schema: {} }, execute: () => {} })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /limits is required/u)
  assert.equal(normaliseEvidenceLimits({ maxLines: 1e6 }).maxLines, 2000, 'declared limits are clamped, not trusted')
})

test('runtime validators reject illegal runtime product with a reason', () => {
  const candidateProblems = validateCandidateSetResult({ candidates: [{ id: 'a', path: 'src/a.ts', locator: {}, text: 'x' }, { id: 'a', path: 'src/a.ts', locator: {}, text: '' }], excluded: [] })
  assert.ok(candidateProblems.some((problem) => /not unique/u.test(problem)), candidateProblems.join('; '))

  const verdictProblems = validateAnchorVerdict({ status: 'anchored', tier: 'no-match', path: 'a', start: 1, end: 1 })
  assert.ok(verdictProblems.some((problem) => /untrusted tier/u.test(problem)), verdictProblems.join('; '))

  const resultProblems = validateEvidenceResult({ items: [] })
  assert.equal(resultProblems.length, 3)

  const promptProblems = validatePromptOutput('verify', { system: 's' })
  assert.equal(promptProblems.length, 1)

  const ruleProblems = validateRuleDocument('---\nname: x\nmatch: []\nneeds-expert-review: false\n---\nshort', 'x.md')
  assert.ok(ruleProblems.some((problem) => /needs-expert-review must be exactly true/u.test(problem)))
})

test('the completion gate refuses a pack that only declares, with named gaps', () => {
  const problems = validateDomainPackV2({ id: 'x', title: 't', category: 'A', lossOrientation: 'precision-first', anchor: { kind: 'k' } })
  assert.ok(problems.length >= 5, problems.join('; '))
  for (const field of ['candidateSource', 'anchorVerifier', 'evidenceTools', 'reviewPrompts', 'ruleLibrary']) {
    assert.ok(problems.some((problem) => problem.includes(field)), `missing ${field} must be named`)
  }
  assert.throws(() => defineDomainPackV2({ id: 'x' }), (error) => error.code === ERROR_CODES.E_CONTRACT)
})

test('the anchor claim descriptor is exported and usable', () => {
  const claim = createAnchorClaim('diff-line', 'a.ts', { start: 2 }, 'const x = 1;')
  assert.equal(claim.kind, 'diff-line')
  assert.equal(claim.locator.start, 2)
})

// ---------------------------------------------------------------------------
console.log('\n2. domains/<id>/ discovery')
// ---------------------------------------------------------------------------

await testAsync('a complete domain directory is discovered, loaded and assembled', async () => {
  const io = createMemoryIo(domainFiles('domains/demo', 'demo'))
  const result = await loadDomains(io, { loadModule: stubLoader(domainFiles('domains/demo', 'demo')) })

  assert.equal(result.root, 'domains')
  assert.equal(result.packs.length, 1, JSON.stringify(result.problems))
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.problems, [])

  const pack = result.packs[0]
  assert.equal(pack.id, 'demo')
  assert.equal(pack.candidateSource.kind, 'demo-candidates', 'source.js was assembled')
  assert.equal(pack.anchorVerifier.kind, 'demo-anchor', 'anchor.js was assembled')
  assert.equal(pack.evidenceTools.tools[0].name, 'peek', 'evidence.js was assembled')
  assert.equal(typeof pack.reviewPrompts.verify, 'function', 'prompts.js was assembled')
  assert.equal(pack.ruleLibrary.rules.length, 20, 'rules/*.md were loaded')
  assert.equal(pack.ruleLibrary.rules[0].needsExpertReview, true)
  assert.equal(pack.ruleLibrary.rules[0].source, 'rule-00.md', 'rule provenance is the file name')
  assert.deepEqual(pack.fixtures, ['empty', 'all-gated-out', 'happy-path'], 'declared fixtures are honoured')
  assert.equal(result.loaded[0].id, 'demo')
})

await testAsync('fixtures/*.json are enumerated when the pack does not list them', async () => {
  const files = domainFiles('domains/fix', 'fix', { pack: { fixtures: undefined } })
  files['domains/fix/fixtures/empty.json'] = '{}'
  files['domains/fix/fixtures/all-gated-out.json'] = '{}'
  files['domains/fix/fixtures/happy-path.json'] = '{}'
  const result = await loadDomains(createMemoryIo(files), { loadModule: stubLoader(files) })
  assert.equal(result.packs.length, 1, JSON.stringify(result.problems))
  assert.deepEqual(result.packs[0].fixtures, ['all-gated-out', 'empty', 'happy-path'])
})

await testAsync('an invalid domain is SKIPPED with readable problems, not loaded', async () => {
  // Four seed rules instead of twenty: the classic "declared but not built" pack.
  const files = domainFiles('domains/thin', 'thin')
  for (const key of Object.keys(files)) {
    const match = /rules\/rule-(\d+)\.md$/u.exec(key)
    if (match !== null && Number(match[1]) >= 4) delete files[key]
  }
  const io = createMemoryIo(files)
  const result = await loadDomains(io, { loadModule: stubLoader(files) })

  assert.equal(result.packs.length, 0, 'an invalid pack must not be registered')
  assert.equal(result.problems.length, 1)
  assert.equal(result.problems[0].id, 'thin')
  assert.ok(result.problems[0].problems.some((problem) => /at least 20/u.test(problem)), result.problems[0].problems.join('; '))
  assert.match(result.skipped[0].reason, /invalid v2 pack/u)
})

await testAsync('a duplicate domain id across roots is REJECTED, first one wins', async () => {
  const files = mergeFiles(domainFiles('roots/a/demo', 'demo'), domainFiles('roots/b/demo', 'demo'))
  const io = createMemoryIo(files)
  const loadModule = stubLoader(files)
  const claimed = new Map()

  const first = await loadDomains(io, { root: 'roots/a', loadModule, claimed })
  assert.deepEqual(first.packs.map((pack) => pack.id), ['demo'])

  const second = await loadDomains(io, { root: 'roots/b', loadModule, claimed })
  assert.equal(second.packs.length, 0, 'the duplicate must not be loaded')
  assert.ok(second.problems.some((entry) => entry.problems.some((problem) => /duplicate domain id/u.test(problem))), JSON.stringify(second.problems))
  assert.match(second.skipped[0].reason, /duplicate domain id rejected/u)
  assert.equal(second.skipped[0].id, 'demo', 'the skip names the duplicated id, not the directory path')
})

await testAsync('a declared id that disagrees with its directory is rejected', async () => {
  const files = domainFiles('domains/alpha', 'not-alpha')
  const io = createMemoryIo(files)
  const result = await loadDomains(io, { loadModule: stubLoader(files) })
  assert.equal(result.packs.length, 0)
  assert.ok(result.problems[0].problems.some((problem) => /must equal the directory name/u.test(problem)))
})

test('discovery skips what is not a domain, with a reason for each', () => {
  const io = createMemoryIo({
    'domains/README.md': 'not a domain',
    'domains/.hidden/index.js': 'export default {}',
    'domains/_template/index.js': 'export default {}',
    'domains/Bad-Name/index.js': 'export default {}',
    'domains/no-entry/readme.md': 'missing index.js',
  })
  const result = discoverDomains(io, {})
  assert.deepEqual(result.found, [])
  const reasons = Object.fromEntries(result.skipped.map((entry) => [entry.id, entry.reason]))
  assert.equal(reasons['README.md'], 'not a directory')
  assert.match(reasons['.hidden'], /dot\/underscore/u)
  assert.match(reasons['_template'], /dot\/underscore/u)
  assert.match(reasons['Bad-Name'], /kebab-case/u)
  assert.match(reasons['no-entry'], /missing index.js/u)
})

test('a missing domain root is an empty result, never an error', () => {
  const result = discoverDomains(createMemoryIo({}), { root: 'domains' })
  assert.deepEqual(result.found, [])
  assert.deepEqual(result.problems, [])
})

await testAsync('every skipped entry carries the SAME shape, at BOTH levels', async () => {
  // The shape itself, locked by name.
  assert.deepEqual([...SKIPPED_ENTRY_KEYS], ['id', 'reason'])

  // Level 1 — directory scan skips.
  const scan = discoverDomains(createMemoryIo({
    'domains/stray.txt': 'not a directory',
    'domains/Bad Name/index.js': 'export default {}',
    'domains/no-entry/readme.md': 'missing index.js',
  }), {})
  assert.equal(scan.skipped.length, 3)
  assert.deepEqual(validateSkippedEntries(scan.skipped), [], 'scan-level entries must validate')

  // Level 2 — domain-package skips (invalid pack, then a rejected duplicate).
  const thin = domainFiles('domains/thin', 'thin')
  for (const key of Object.keys(thin)) {
    const match = /rules\/rule-(\d+)\.md$/u.exec(key)
    if (match !== null && Number(match[1]) >= 4) delete thin[key]
  }
  const dup = mergeFiles(
    domainFiles('roots/a/demo', 'demo'),
    domainFiles('roots/b/demo', 'demo'),
    thin,
  )
  const io = createMemoryIo(dup)
  const loadModule = stubLoader(dup)
  const claimed = new Map()
  const firstRoot = await loadDomains(io, { root: 'roots/a', loadModule, claimed })
  assert.deepEqual(firstRoot.packs.map((pack) => pack.id), ['demo'])
  const secondRoot = await loadDomains(io, { root: 'roots/b', loadModule, claimed })
  const invalidPack = await loadDomains(createMemoryIo(thin), { loadModule: stubLoader(thin) })
  assert.equal(invalidPack.packs.length, 0, 'the thin pack must be skipped')

  const all = [...secondRoot.skipped, ...invalidPack.skipped]
  assert.equal(all.length, 2, JSON.stringify(all))
  assert.deepEqual(validateSkippedEntries(all), [], 'package-level entries must validate too')

  // One key set, so `skipped.map((entry) => entry.id)` is always meaningful.
  for (const entry of all) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'reason'])
    assert.equal(typeof entry.id, 'string')
    assert.notEqual(entry.id, '')
    assert.notEqual(entry.reason, '')
  }

  // The duplicate reports the DECLARED id, not the directory path, so filtering
  // by id sees the same value the registry would hold.
  const duplicate = secondRoot.skipped.find((entry) => /duplicate domain id rejected/u.test(entry.reason))
  assert.ok(duplicate, JSON.stringify(secondRoot.skipped))
  assert.equal(duplicate.id, 'demo')
  assert.match(duplicate.reason, /roots\/a\/demo/u, 'the paths stay in the reason')

  // And the validator actually rejects drift, so this test can fail.
  assert.deepEqual(validateSkippedEntry({ id: 'a', reason: 'r' }), [])
  const drifted = validateSkippedEntry({ name: 'a', reason: 'r' })
  assert.match(drifted[0], /must carry exactly id \+ reason/u, 'the old {name} shape is now invalid')
  assert.match(drifted[1], /\.id must be a non-empty string/u)
  assert.equal(validateSkippedEntry({ id: 'a' }).length, 2, 'a missing reason and a wrong key set are both named')
  assert.equal(validateSkippedEntry(null).length, 1)
})

await testAsync('a broken rule document fails the domain rather than silently shrinking its library', async () => {
  const files = domainFiles('domains/rules', 'rules')
  files['domains/rules/rules/rule-03.md'] = '---\nname: rule-03\nmatch:\n  - "**/*.ts"\n---\n没有 provenance 标注。'
  const io = createMemoryIo(files)
  const result = await loadDomains(io, { loadModule: stubLoader(files) })
  assert.equal(result.packs.length, 0)
  assert.ok(result.problems[0].problems.some((problem) => /needs-expert-review/u.test(problem)), result.problems[0].problems.join('; '))
})

await testAsync('loadDomain reports a missing default export instead of guessing', async () => {
  const io = createMemoryIo({ 'domains/x/index.js': 'export const notADefault = 1' })
  const result = await loadDomain(io, { id: 'x', dir: 'domains/x' }, { loadModule: stubLoader({ 'domains/x/index.js': {} }) })
  assert.equal(result.pack, undefined)
  assert.match(result.problems[0], /default-export/u)
})

// ---------------------------------------------------------------------------
console.log('\n3. the nineteen inline packs still work')
// ---------------------------------------------------------------------------

await testAsync('adjudication_domains still reports exactly 19 domains with no directories', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19)
  assert.equal(listed.directory.loaded.length, 0, 'no domain is discoverable through the memory io')
  assert.match(listed.summary, /领域目录/u)
})

// CHANGED (t4). Was: `assert.equal(listed.count, 19)` on the REAL filesystem,
// with the note "no domains/ directory exists in this package". That assumption
// is now false — `domains/code-review/` exists and is exactly the migration this
// kernel is built to support. The replacement is STRICTER than what it replaces:
// it pins the count under BOTH I/O, so a directory pack can neither disappear
// nor silently change the total. What was preserved: "the built-in library is
// nineteen domains, and discovery does not change that count."
// CHANGED (t17). Two earlier forms of this test are both gone:
//   • `assert.equal(listed.count, 19)` against the REAL directory scan (t2/t4).
//     That is semantically wrong, not merely brittle. A directory pack whose id
//     is NOT one of the built-in packs is a SUPPORTED outcome — the loader
//     reports it in `added` rather than rejecting it — and it legitimately makes
//     the registry one domain larger. Asserting the literal 19 both hard-coded
//     the number and denied a designed-for case.
//   • `assert.equal(listed.directory.added.length, 0)` (`added` is empty). Same
//     mistake in a different disguise: it pinned the current set of domain ids.
//
// What is asserted instead is the accounting rule, which holds at every point of
// the migration and does not name a single domain:
//   • the built-in library alone is 19 (pinned under the memory io, which sees
//     no directories at all);
//   • every loaded directory pack is accounted for exactly once — replaced
//     (its id matched a built-in) or added (it did not), never both, never
//     neither;
//   • registry size == built-ins + additions, derived rather than hard-coded;
//   • every replaced id is still registered, because replacement is not removal.
await testAsync('the domain count follows the accounting rule, not a hard-coded 19', async () => {
  const isolated = createContext(PROMPT_SERVICE)
  apply(isolated, EMPTY_DOMAIN_IO)
  const isolatedCount = (await isolated.__tools.get('adjudication_domains').execute({}, {})).count
  assert.equal(isolatedCount, 19, 'the built-in library is nineteen domains')

  const real = createContext(PROMPT_SERVICE)
  apply(real, {})
  const listing = await real.__tools.get('adjudication_domains').execute({}, {})

  const builtins = 19
  const replaced = listing.directory.replaced ?? []
  const added = listing.directory.added ?? []
  const loaded = listing.directory.loaded ?? []

  assert.deepEqual(
    [...replaced, ...added].sort(),
    [...loaded].sort(),
    'every loaded directory pack is accounted for exactly once, as a replacement or an addition',
  )
  assert.equal(new Set([...replaced, ...added]).size, loaded.length, 'no directory pack may be counted twice')
  assert.equal(
    listing.count,
    builtins + added.length,
    `registry size must be "built-ins + additions" (19 + ${added.length}), got ${listing.count}`,
  )
  for (const id of replaced) {
    assert.ok(listing.domains.some((domain) => domain.id === id), `replaced id "${id}" must still be registered`)
  }
  assert.ok(listing.domains.some((domain) => domain.id === 'code-review'), 'the reference domain is always present')
})

await testAsync('the core tool surface is unchanged and activation still yields the declared domain toolset', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  // CHANGED (t4). Was: `assert.deepEqual([...ctx.__tools.keys()].sort(), [six core tools])`
  // and activation of `code-review` asserted exactly three tools.
  //
  // Two assumptions had to go, and both were only true while no domain had
  // extension-point tools:
  //   • the "six core tools" always have the `adjudication_` prefix, so the
  //     assertion now filters on that prefix instead of comparing the whole map.
  //     It is the same statement — "the plugin's own surface is six tools and no
  //     seventh appeared" — but it no longer conflates the CORE surface with the
  //     PER-DOMAIN surface that activation is supposed to create.
  //   • per-domain tool counts are asserted against the registry's DECLARED
  //     names (`domainToolNames()`), not a handwritten list. `code-review` now
  //     also contributes three bounded evidence tools on activation, which is a
  //     contract requirement (evidence.js, P7) and not a regression.
  // Preserved: activation registers exactly the declared domain toolset; the
  // core surface is unchanged in number and in name.
  apply(ctx, EMPTY_DOMAIN_IO)
  const core = [...ctx.__tools.keys()].filter((name) => name.startsWith('adjudication_'))
  assert.deepEqual(core.sort(), CORE_TOOL_NAMES.slice().sort(),
    'the plugin surface is the six core tools and nothing else')

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  for (const name of domainToolNames('code-review')) {
    assert.ok(activated.tools.includes(name), `${name} must be registered by activation: ${JSON.stringify(activated.tools)}`)
  }
  for (const name of domainToolNames('code-review')) {
    assert.ok(ctx.__tools.has(name), `${name} must exist on the tool map after activation`)
  }
})

await testAsync('a directory pack registers through the plugin and joins the registry', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 20, 'directory pack added to the nineteen built-ins')
  assert.deepEqual(listed.directory.loaded, ['demo'])
  assert.deepEqual(listed.directory.added, ['demo'])

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'demo' }, {})
  assert.deepEqual(activated.tools.sort(), [
    'adjudicate_demo', 'adjudicate_demo_evidence_peek', 'adjudicate_demo_plan', 'adjudicate_demo_rules',
  ], JSON.stringify(activated))
})

await testAsync('deactivating a directory pack withdraws its evidence tools too', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'demo' }, {})
  assert.equal(ctx.__tools.has('adjudicate_demo_evidence_peek'), true)
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'demo' }, {})
  assert.equal(ctx.__tools.has('adjudicate_demo_evidence_peek'), false)
  assert.equal(ctx.__tools.has('adjudicate_demo'), false)
  assert.equal(ctx.__tools.has('adjudication_domains'), true, 'core tools survive')
})

test('registerLoadedDomains reports replacements, which is the migration path', () => {
  const registered = new Map([['code-review', { id: 'code-review' }]])
  const registry = {
    has: (id) => registered.has(id),
    register: (pack) => { registered.set(pack.id, pack); return () => registered.delete(pack.id) },
  }
  const outcome = registerLoadedDomains(registry, { packs: [{ id: 'code-review' }, { id: 'brand-new' }] })
  assert.deepEqual(outcome.replaced, ['code-review'])
  assert.deepEqual(outcome.added, ['brand-new'])
})

// ---------------------------------------------------------------------------
console.log('\n4. bundleKey participates in bundling')
// ---------------------------------------------------------------------------

await testAsync('candidates without a key are grouped by the pack bundleKey', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ path: `src/${name}.ts`, additions: 1 }))
  // CHANGED (t4). Was `domain: 'code-review'` — the one and only built-in pack
  // whose string bundleKey the engine can activate.
  //
  // Why the domain had to change: this test asserts the LEGACY-STRING path of
  // `resolveBundleKey` — a pack declaring `bundleKey: 'directory'` has it applied
  // under `trustDeclaredStrategies`. `code-review` no longer declares a string;
  // its v2 package declares the object form, which always applies. And an audit
  // of all nineteen packs shows every OTHER one declares a domain-private
  // strategy (`regulation`, `flow`, `module`, …) that `BUNDLE_KEY_STRATEGIES`
  // deliberately does not implement — which is why `code-review` was the only
  // candidate, and why its migration removed the last carrier of this path.
  //
  // So the subject is now a v1-shaped pack registered through the public facade,
  // which is exactly how a downstream row contributes a domain. Every original
  // assertion is kept unchanged; only the pack under test is synthetic, and it is
  // synthetic precisely so the string-opt-in path keeps a real carrier instead of
  // being tested only through `resolveBundleKey` in isolation.
  const facade = ctx.get('adjudication')
  const dispose = facade.registerDomain({
    id: 'legacy-directory-pack',
    title: 'Legacy directory-grouped pack',
    category: 'A',
    lossOrientation: 'precision-first',
    anchor: { kind: 'whatever' },
    bundleKey: 'directory',
  })
  try {
    const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'legacy-directory-pack', target: 't', candidates }, {})

    assert.equal(plan.bundleKey.declared, 'directory')
    assert.equal(plan.bundleKey.applied, true, plan.bundleKey.reason)
    assert.equal(plan.bundleKey.strategy, 'directory')
    assert.equal(plan.bundleKey.source, 'derived')
    assert.equal(plan.bundleKey.derived, 5)
    assert.equal(plan.bundles.length, 1, 'five paths in one directory must form ONE bundle')
    assert.equal(plan.bundles[0].key, 'src')
    assert.equal(plan.bundles[0].paths.length, 5)
  } finally {
    dispose()
  }
})

await testAsync('an object-form bundleKey applies without any opt-in (the v2 migration path)', async () => {
  // ADDED (t4). The complement of the test above, and the reason it had to move:
  // the object form is documented to apply UNCONDITIONALLY, and the previous
  // test — which used `code-review` for both paths — could not express that.
  //
  // This one deliberately uses the REAL io: the subject is a pack that was
  // MIGRATED to a v2 directory, so discovery has to run for the test to mean
  // anything. If `domains/code-review/` is ever removed, this test fails loudly
  // instead of quietly testing the v1 pack that would replace it.
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, {})
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ path: `src/${name}.ts`, additions: 1 }))
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'code-review', target: 't', candidates }, {})

  assert.deepEqual(plan.bundleKey.declared, { strategy: 'directory', depth: 1 },
    'code-review must be the v2 directory pack here — discovery, not the v1 twin')
  assert.equal(plan.bundleKey.applied, true, plan.bundleKey.reason)
  assert.equal(plan.bundleKey.source, 'derived')
  assert.equal(plan.bundleKey.derived, 5)
  assert.equal(plan.bundles.length, 1)
  assert.equal(plan.bundles[0].key, 'src')
})

await testAsync('an explicit candidate key wins over the pack bundleKey', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  const candidates = ['a', 'b', 'c', 'd'].map((name) => ({ path: `src/${name}.ts`, key: 'explicit-group' }))
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'code-review', candidates }, {})
  assert.equal(plan.bundleKey.derived, 0)
  assert.equal(plan.bundles.length, 1)
  assert.equal(plan.bundles[0].key, 'explicit-group')
})

await testAsync('a strategy that is not implemented falls back and says so', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  // `regulation` is a legacy v1 string with no generic strategy behind it.
  const candidates = ['a', 'b', 'c', 'd'].map((name) => ({ path: `flow/${name}`, additions: 1 }))
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'risk-compliance', candidates }, {})
  assert.equal(plan.bundleKey.applied, false)
  assert.match(plan.bundleKey.reason, /not activated|unknown/u)
  assert.equal(plan.bundles.length, 4, 'falls back to one bundle per path')
})

test('resolveBundleKey precedence is explicit in the contract', () => {
  assert.equal(resolveBundleKey({ bundleKey: { strategy: 'directory' } }, { path: 'a/b/c.ts', key: 'mine' }).source, 'entry')
  assert.equal(resolveBundleKey({ bundleKey: { strategy: 'directory' } }, { path: 'a/b/c.ts' }).source, 'derived')
  assert.equal(resolveBundleKey({}, { path: 'a/b/c.ts' }).source, 'fallback')
})

test('rulesOf answers for BOTH pack shapes, and never returns undefined', () => {
  assert.deepEqual(rulesOf({ rules: [{ name: 'inline' }] }).map((rule) => rule.name), ['inline'])
  assert.deepEqual(rulesOf({ ruleLibrary: { rules: [{ name: 'library' }] } }).map((rule) => rule.name), ['library'])
  // A v2 library wins when it carries rules — that is the loader-assembled one.
  assert.deepEqual(
    rulesOf({ rules: [{ name: 'inline' }], ruleLibrary: { rules: [{ name: 'library' }] } }).map((rule) => rule.name),
    ['library'],
  )
  // An empty library must not shadow non-empty inline rules.
  assert.deepEqual(
    rulesOf({ rules: [{ name: 'inline' }], ruleLibrary: { rules: [] } }).map((rule) => rule.name),
    ['inline'],
  )
  assert.deepEqual(rulesOf({}), [])
  assert.deepEqual(rulesOf(null), [])
  assert.deepEqual(rulesOf(undefined), [])
})

await testAsync('P3 injects rules for a v2 DIRECTORY pack, not only for v1 inline rules', async () => {
  // Regression for the t17 defect: `planFor()` used to read `pack.rules` alone,
  // so every contract-v2 directory pack — whose rules the loader assembles into
  // `ruleLibrary.rules` — got `bundles[].rules === []` and `ruleText === ''`.
  // Rule injection was inert on exactly the packs the migration produces.
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const candidates = ['a', 'b', 'c', 'd'].map((name) => ({ path: `src/${name}.ts`, additions: 1 }))
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'demo', target: 'v2 rules', candidates }, {})

  assert.equal(plan.bundles.length, 1, JSON.stringify(plan.bundles))
  const bundle = plan.bundles[0]
  assert.ok(bundle.rules.length > 0, `P3 must inject rules for a v2 pack — got ${JSON.stringify(bundle.rules)}`)
  assert.notEqual(bundle.ruleText, '', 'ruleText must carry the rendered norms, not an empty string')

  // The injected set must be exactly what the primitive selects from the LOADED
  // library over this bundle's paths — no more, no fewer.
  const loaded = await loadDomains(createMemoryIo(files), { loadModule: stubLoader(files) })
  const library = loaded.packs[0].ruleLibrary.rules
  assert.ok(library.length >= 20, 'the loaded library is the v2 rules/*.md set')
  const expected = selectRules(library, bundle.paths).injected
  assert.equal(bundle.rules.length, expected.length)
  assert.deepEqual(bundle.rules, expected.map((rule) => rule.name))

  // And the registry overview must report the same library size, not zero.
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  const demo = listed.domains.find((domain) => domain.id === 'demo')
  assert.equal(demo.rules, library.length, 'the overview counts the v2 library too')

  // The per-domain rules tool agrees with both.
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'demo' }, {})
  const rulesTool = await ctx.__tools.get('adjudicate_demo_rules').execute({}, {})
  assert.equal(rulesTool.rules.length, library.length)
  assert.match(rulesTool.summary, /needs-expert-review/u)
})

// ---------------------------------------------------------------------------
console.log('\n5. candidateSet and criticism.kind are read')
// ---------------------------------------------------------------------------

await testAsync('input drives candidateSource, and the plan reports its provenance', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'demo',
    target: '演示输入',
    input: { format: 'demo-input', payload: { items: [{ path: 'a/b.ts' }, { path: 'a/c.ts' }, { path: 'a/d.ts' }, { path: 'a/e.ts' }] } },
  }, {})

  assert.equal(plan.candidateSet.origin, 'candidateSource')
  assert.equal(plan.candidateSet.kind, 'demo-candidates')
  assert.equal(plan.candidateSet.inputFormat, 'demo-input')
  assert.equal(plan.candidateSet.bounded, true)
  assert.deepEqual(plan.candidateSet.problems, [])
  assert.equal(plan.gate.admitted, 4)
  // The candidateSource enumerates them; the pack's bundleKey then groups them.
  assert.equal(plan.bundleKey.applied, true)
  assert.equal(plan.bundles.length, 1)
  assert.equal(plan.bundles[0].key, 'a')
})

await testAsync('caller-supplied candidates are still reported as such', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'code-review', candidates: [{ path: 'src/a.ts' }] }, {})
  assert.equal(plan.candidateSet.origin, 'caller-supplied')
  assert.equal(plan.candidateSet.kind, 'diff-hunks')
})

await testAsync('a domain with no candidateSource refuses input with an actionable message', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  // CHANGED (t4). Was a single call against `code-review` with
  // `input: { format: 'unified-diff', payload: {} }`, asserting /没有 candidateSource/.
  //
  // The assertion's subject is "a domain with NO candidateSource produces an
  // actionable refusal". Its old fixture was `code-review`, which had no source
  // at the time; now that `code-review` is a v2 directory pack it HAS one, so the
  // same call fails one step later with a different (also correct) error:
  // "unified-diff 输入缺少字符串字段 `diff`". Two things were wrong with the old
  // form, and both are fixed rather than papered over:
  //   • the subject domain had to be one WITHOUT a source — `risk-compliance`;
  //   • a `{}` payload happened to pass for one that exercised the missing
  //     surface, so the new pair pins BOTH branches: no source -> refusal naming
  //     the source; source present but malformed -> refusal naming the field.
  // The second call deliberately uses the REAL io, so it can only pass while a
  // v2 `code-review` directory is actually being discovered.
  apply(ctx, EMPTY_DOMAIN_IO)
  await assert.rejects(
    () => ctx.__tools.get('adjudication_plan').execute({ domain: 'risk-compliance', input: { format: 'clause-and-surface', payload: {} } }, {}),
    /没有 candidateSource/u,
  )

  const discovered = createContext(PROMPT_SERVICE)
  apply(discovered, {})
  await assert.rejects(
    () => discovered.__tools.get('adjudication_plan').execute({ domain: 'code-review', input: { format: 'unified-diff', payload: {} } }, {}),
    /缺少字符串字段 `diff`/u,
    'with a real v2 source present, the refusal must name the malformed field instead of the missing source',
  )
})

await testAsync('a mismatched input format is refused, not coerced', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  await assert.rejects(
    () => ctx.__tools.get('adjudication_plan').execute({ domain: 'demo', input: { format: 'wrong-format', payload: {} } }, {}),
    /文档化输入格式/u,
  )
})

await testAsync('criticism.kind is read by submit and labelled in the report', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)

  const strict = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'code-review',
    findings: [{ id: 'f1', path: 'src/a.ts', start: 1, severity: 'high', message: 'm', evidence: 'e', defended: true }],
  }, {})
  assert.equal(strict.criticismKind, 'fact-checker')
  assert.match(strict.summary, /fact-checker/u)

  const triage = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'risk-compliance',
    // CHANGED (t17): submit recomputes anchors now, so an undecided finding must
    // still be an ANCHORED one for recall-first to have anything to keep. Its
    // excerpt is quoted verbatim and the document is supplied; the assertions
    // below are unchanged.
    documents: [{ path: 'surface/x', content: 'clause 3.2 requires a control description' }],
    findings: [{ id: 'f2', path: 'surface/x', start: 1, severity: 'low', message: 'm', evidence: 'clause 3.2 requires a control description' }],
  }, {})
  assert.equal(triage.criticismKind, 'triage')
  assert.match(triage.summary, /triage/u)
  assert.equal(triage.findings.length, 1, 'recall-first still keeps an undecided finding')
})

await testAsync('the plan reports the reviewer shape it will hand to P6', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'data-engineering', candidates: [{ path: 'dags/a.py' }] }, {})
  assert.equal(plan.criticism.kind, 'triage')
  assert.equal(plan.lossOrientation, 'recall-first')
})

// ---------------------------------------------------------------------------
console.log('\n6. the P4 bounded inference executor')
// ---------------------------------------------------------------------------

function fakeSubagents(behaviour = {}) {
  const calls = []
  calls.disposed = 0
  return {
    calls,
    service: {
      async start(request) {
        calls.push(request)
        if (behaviour.rejectOnce !== undefined && calls.length <= behaviour.rejectOnce.withSchema) {
          const wantsOptional = request.outputSchema !== undefined || request.toolFilter !== undefined
          if (wantsOptional) throw new Error('provider does not support outputSchema')
        }
        const result = behaviour.result ?? { stopReason: 'completed', structured: { findings: [{ id: 'f1', message: 'm', evidence: 'e' }] }, output: [] }
        return {
          id: 'child-1',
          result: Promise.resolve(typeof result === 'function' ? result(request) : result),
          dispose: async () => { calls.disposed += 1 },
        }
      },
    },
  }
}

const REASONER_PACK = {
  id: 'demo',
  title: '演示领域',
  lossOrientation: 'precision-first',
  prompt: { role: 'role', instruction: 'instruction' },
  reviewPrompts: { review: () => ({ system: 'P4 提示词' }), verify: () => ({ system: 'P6', instructions: 'i' }) },
}

test('no service at all degrades to mode "none" without throwing', async () => {
  const reasoner = createReasoner({})
  assert.equal(reasoner.available, false)
  assert.equal(reasoner.mode, 'none')
  const outcome = await reasoner.run({ pack: REASONER_PACK, bundles: [{ key: 'a', paths: ['x'] }] })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, REASONER_CODES.E_NO_REASONER)
  assert.deepEqual(outcome.skipped, ['a'], 'unrun bundles are reported, never silently dropped')
  assert.match(outcome.reason, /neither ctx.subagents nor ctx.llm/u)
})

test('describeReasoner prefers subagents and flags the llm path as degraded', () => {
  assert.equal(describeReasoner({}).mode, 'none')
  assert.equal(describeReasoner({ llm: {} }).mode, 'llm')
  assert.equal(describeReasoner({ llm: {} }).degraded, true)
  assert.equal(describeReasoner({ subagents: {} }).mode, 'subagents')
  assert.equal(describeReasoner({ subagents: {}, llm: {} }).mode, 'subagents')
})

test('a service that mounts late is picked up without re-applying', () => {
  let mounted
  const reasoner = createReasoner(() => ({ subagents: mounted }))
  assert.equal(reasoner.available, false)
  mounted = {}
  assert.equal(reasoner.available, true)
  assert.equal(reasoner.mode, 'subagents')
})

test('the ledger is respected: no pass starts once the budget is exhausted', async () => {
  const fake = fakeSubagents()
  const reasoner = createReasoner({ subagents: fake.service })
  const charges = []
  const outcome = await reasoner.run({
    pack: REASONER_PACK,
    bundles: [{ key: 'a' }, { key: 'b' }],
    getBudget: () => ({ exhausted: true, settings: { maxToolCalls: 1 } }),
    onCharge: (entry) => charges.push(entry),
  })
  assert.equal(fake.calls.length, 0, 'no child may be started on an exhausted ledger')
  assert.equal(outcome.code, REASONER_CODES.E_BUDGET_EXHAUSTED)
  assert.deepEqual(outcome.skipped, ['a', 'b'])
  assert.deepEqual(charges, [])
})

test('the budget is charged BEFORE the work is admitted (lookahead)', async () => {
  const fake = fakeSubagents()
  const reasoner = createReasoner({ subagents: fake.service })
  const charges = []
  const outcome = await reasoner.run({
    pack: REASONER_PACK,
    bundles: [{ key: 'a' }, { key: 'b' }],
    getBudget: () => ({ exhausted: false, settings: { maxToolCalls: 10 } }),
    onCharge: (entry) => charges.push(entry),
  })
  assert.equal(outcome.rounds, 2)
  assert.equal(charges.length, 2, 'one charge per admitted pass')
  assert.ok(charges.every((entry) => entry.toolCalls === 1))
  assert.equal(outcome.findings.length, 2)
  assert.equal(fake.calls.disposed, 2, 'every run must be disposed')
})

test('the caller AbortSignal is forwarded verbatim and disposition is honoured on abort', async () => {
  const fake = fakeSubagents({ result: { stopReason: 'aborted', output: [] } })
  const reasoner = createReasoner({ subagents: fake.service })
  const controller = new AbortController()
  const outcome = await reasoner.run({
    pack: REASONER_PACK,
    bundles: [{ key: 'a' }],
    signal: controller.signal,
    getBudget: () => ({ exhausted: false, settings: {} }),
  })
  assert.equal(fake.calls[0].signal, controller.signal, 'the SAME signal object must reach the child')
  assert.equal(outcome.code, REASONER_CODES.E_ABORTED)
  assert.equal(outcome.findings.length, 0)
  assert.equal(fake.calls.disposed, 1, 'dispose runs even on abort')
})

test('a pass that never starts because the signal already fired starts no child', async () => {
  const fake = fakeSubagents()
  const reasoner = createReasoner({ subagents: fake.service })
  const controller = new AbortController()
  controller.abort()
  const outcome = await reasoner.run({
    pack: REASONER_PACK,
    bundles: [{ key: 'a' }],
    signal: controller.signal,
    getBudget: () => ({ exhausted: false, settings: {} }),
  })
  assert.equal(fake.calls.length, 0)
  assert.equal(outcome.code, REASONER_CODES.E_ABORTED)
})

test('a non-completed stop reason is a failure, never "no findings"', async () => {
  const fake = fakeSubagents({ result: { stopReason: 'max-tokens', output: [], diagnostic: 'hit ceiling' } })
  const reasoner = createReasoner({ subagents: fake.service })
  const outcome = await reasoner.run({
    pack: REASONER_PACK, bundles: [{ key: 'a' }], getBudget: () => ({ exhausted: false, settings: {} }),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errors.length, 1)
  assert.equal(outcome.errors[0].code, REASONER_CODES.E_STOP_REASON)
  assert.equal(outcome.findings.length, 0)
  assert.match(outcome.errors[0].detail, /hit ceiling/u)
})

test('a provider that declines outputSchema is retried without it and reported as degraded', async () => {
  const fake = fakeSubagents()
  let first = true
  const service = {
    async start(request) {
      if (first && (request.outputSchema !== undefined || request.toolFilter !== undefined)) {
        first = false
        throw new Error('provider does not support outputSchema')
      }
      return fake.service.start(request)
    },
  }
  const reasoner = createReasoner({ subagents: service })
  const outcome = await reasoner.run({
    pack: REASONER_PACK,
    bundles: [{ key: 'a' }],
    outputSchema: { type: 'object' },
    toolFilter: { allow: ['x'] },
    getBudget: () => ({ exhausted: false, settings: {} }),
  })
  assert.equal(outcome.degraded, true, 'dropping a protection must be visible')
  assert.equal(outcome.findings.length, 1)
})

test('the prompt falls back to pack.prompt when reviewPrompts throws', async () => {
  const fake = fakeSubagents()
  const reasoner = createReasoner({ subagents: fake.service })
  const outcome = await reasoner.run({
    pack: { ...REASONER_PACK, reviewPrompts: { review: () => { throw new Error('broken prompt') }, verify: () => ({}) } },
    bundles: [{ key: 'a' }],
    getBudget: () => ({ exhausted: false, settings: {} }),
  })
  assert.equal(outcome.ok, true, 'a broken prompt is a text-layer problem, not a pipeline failure')
  assert.match(fake.calls[0].prompt[0].text, /instruction/u)
})

test('the llm fallback streams, collects text and forwards the signal', async () => {
  const seen = []
  const controller = new AbortController()
  const reasoner = createReasoner({
    llm: {
      listProviders: () => [{ id: 'p1' }],
      listModels: () => [{ id: 'm1' }],
      stream: (options) => {
        seen.push(options)
        return (async function* generate() {
          yield { text: '```json\n' }
          yield { text: '{"findings":[{"id":"l1","message":"from llm"}]}\n' }
          yield { text: '```' }
        })()
      },
    },
  })
  const outcome = await reasoner.run({
    pack: REASONER_PACK, bundles: [{ key: 'a' }], signal: controller.signal,
    getBudget: () => ({ exhausted: false, settings: {} }),
  })
  assert.equal(outcome.mode, 'llm')
  assert.equal(outcome.degraded, true)
  assert.equal(seen[0].signal, controller.signal)
  assert.equal(seen[0].provider, 'p1')
  assert.equal(outcome.findings.length, 1)
  assert.equal(outcome.findings[0].id, 'l1')
})

test('the llm fallback without a resolvable route reports it instead of guessing', async () => {
  const reasoner = createReasoner({ llm: { stream: () => (async function* empty() {})() } })
  const outcome = await reasoner.run({
    pack: REASONER_PACK, bundles: [{ key: 'a' }], getBudget: () => ({ exhausted: false, settings: {} }),
  })
  assert.equal(outcome.errors[0].code, REASONER_CODES.E_NO_ROUTE)
})

test('unstructured output is parsed tolerantly and never throws', () => {
  assert.deepEqual(extractFindings('no json here'), [])
  assert.equal(extractFindings('{"findings":[{"id":"a"}]}').length, 1)
  assert.equal(extractFindings('prefix ```json\n[{"id":"b"}]\n``` suffix').length, 1)
  assert.equal(extractFindings('{"findings":[{"text":"}"}]}').length, 1, 'braces inside strings must not end the scan')
})

// ---------------------------------------------------------------------------
console.log('\n7. the plugin wires the P4 executor in, optionally')
// ---------------------------------------------------------------------------

await testAsync('without a reasoning service the core surface is exactly six tools', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  assert.deepEqual([...ctx.__tools.keys()].sort(), [
    'adjudicate_code_review', 'adjudicate_code_review_plan', 'adjudicate_code_review_rules',
    'adjudication_activate', 'adjudication_anchor', 'adjudication_deactivate',
    'adjudication_domains', 'adjudication_plan', 'adjudication_submit',
  ])
  assert.equal(ctx.get('adjudication').reasoner.describe().mode, 'none')
})

await testAsync('with ctx.subagents mounted, activating a domain adds the P4 tool', async () => {
  const fake = fakeSubagents()
  const ctx = createContext({ ...PROMPT_SERVICE, subagents: fake.service })
  apply(ctx, EMPTY_DOMAIN_IO)

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  assert.ok(activated.tools.includes('adjudicate_code_review_review'), JSON.stringify(activated.tools))

  const review = ctx.__tools.get('adjudicate_code_review_review')
  const outcome = await review.execute({
    target: 'PR#1',
    candidates: [{ path: 'src/a.ts', additions: 1 }],
  }, {})

  assert.equal(outcome.domain, 'code-review')
  assert.equal(outcome.mode, 'subagents')
  assert.equal(outcome.rounds, 1)
  assert.equal(outcome.findings.length, 1)
  assert.equal(fake.calls.length, 1, 'exactly one bounded pass for one bundle')
  assert.equal(fake.calls[0].parent, undefined, 'no exec.agent in this harness')
  assert.ok(fake.calls[0].prompt[0].text.includes('代码评审') || fake.calls[0].prompt[0].text.length > 0)
})

await testAsync('the P4 tool forwards exec.signal to the child', async () => {
  const fake = fakeSubagents()
  const ctx = createContext({ ...PROMPT_SERVICE, subagents: fake.service })
  apply(ctx, EMPTY_DOMAIN_IO)
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  const controller = new AbortController()
  await ctx.__tools.get('adjudicate_code_review_review').execute(
    { target: 'PR#1', candidates: [{ path: 'src/a.ts', additions: 1 }] },
    { signal: controller.signal },
  )
  assert.equal(fake.calls[0].signal, controller.signal)
})

await testAsync('the registry facade exposes the reasoner and it degrades without services', async () => {
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, EMPTY_DOMAIN_IO)
  const facade = ctx.get('adjudication')
  assert.equal(typeof facade.reasoner.run, 'function')
  assert.equal(facade.contractVersion, 2)
  const outcome = await facade.reasoner.run({ pack: REASONER_PACK, bundles: [{ key: 'a' }] })
  assert.equal(outcome.available, false)
  assert.equal(outcome.code, REASONER_CODES.E_NO_REASONER)
})

await testAsync('the registry facade exposes the directory scan state', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  assert.equal(ctx.get('adjudication').domainDirectory(), null, 'lazy: nothing scanned before first use')
  await ctx.__tools.get('adjudication_domains').execute({}, {})
  const state = ctx.get('adjudication').domainDirectory()
  assert.equal(state.packs.length, 1)
  assert.equal(state.replaced.length, 0)
})

await testAsync('the plugin default enables bundleKey derivation and can be turned off', async () => {
  // CHANGED (t4). Domain moved from `code-review` to `ux-review`, and the second
  // assertion's meaning is now spelled out.
  //
  // Why: `trustDeclaredStrategies` governs the LEGACY STRING form only. The old
  // test used `code-review`, whose v2 package declares the object form — and the
  // object form always applies (contract, §2), so "opting out" could not turn it
  // off. The failure was the test asserting a design the contract does not have,
  // not the plugin ignoring a flag. `ux-review` still declares the string, so
  // this now tests what it says it tests.
  // Preserved exactly: (a) the DEFAULT is `true`; (b) with the flag off, a
  // declared string strategy is NOT applied; (c) opting out restores v1 grouping.
  assert.equal(DEFAULT_OPTIONS.bundleKey.trustDeclaredStrategies, true)
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { ...EMPTY_DOMAIN_IO, bundleKey: { trustDeclaredStrategies: false } })
  const candidates = ['a', 'b', 'c', 'd'].map((name) => ({ path: `src/${name}.ts` }))
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'ux-review', candidates }, {})
  assert.equal(plan.bundleKey.applied, false)
  assert.match(plan.bundleKey.reason, /not activated|unknown/u,
    'the refusal must say WHY the declared strategy was not used')
  assert.equal(plan.bundles.length, 4, 'opting out restores v1 grouping exactly')
})
// ---------------------------------------------------------------------------
console.log('\n8. F3 — the domain verifier is CALLED, not bypassed')
// ---------------------------------------------------------------------------

const F3_DOCUMENTS = [{ path: 'src/real.ts', content: 'const real = 1\nconst other = 2' }]

await testAsync('adjudication_anchor runs the DOMAIN verifier; a throwing one is not swallowed', async () => {
  const files = domainFiles('domains/boom', 'boom')
  files['domains/boom/anchor.js'] = {
    default: {
      __contract: CONTRACT_VERSION,
      kind: 'boom-anchor',
      verify: () => { throw new Error('领域验证器确实被调用了') },
    },
  }
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  // Control: with no domain named, the generic ladder answers and says so.
  const generic = await ctx.__tools.get('adjudication_anchor').execute({
    excerpt: 'const real = 1', path: 'src/real.ts', documents: F3_DOCUMENTS,
  }, {})
  assert.equal(generic.status, 'anchored')
  assert.equal(generic.via, 'engine-resolveAnchor', 'the fallback must identify itself')

  // With the domain named, the domain verifier MUST run. t5 measured the old
  // behaviour: this call returned a normal verdict because index.js called the
  // generic ladder and never consulted `pack.anchorVerifier`.
  await assert.rejects(
    () => ctx.__tools.get('adjudication_anchor').execute({
      domain: 'boom', excerpt: 'const real = 1', path: 'src/real.ts', documents: F3_DOCUMENTS,
    }, {}),
    (error) => {
      assert.match(String(error?.message), /领域验证器确实被调用了/u)
      assert.match(String(error?.message), /boom/u, 'the error must name the domain')
      return true
    },
  )
})

await testAsync('adjudication_anchor reports which path ran, for a migrated domain', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const anchored = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'demo', excerpt: 'const other = 2', path: 'src/real.ts', documents: F3_DOCUMENTS,
  }, {})
  assert.equal(anchored.status, 'anchored')
  assert.equal(anchored.via, 'anchorVerifier')
  assert.equal(anchored.domain, 'demo')
  assert.equal(anchored.start, 2)
  assert.match(anchored.summary, /anchorVerifier/u)
})

await testAsync('a fabricated anchor cannot buy coverage: submit recomputes, it does not trust', async () => {
  // This is the t5 counterexample, verbatim: a path that does not exist and
  // `start: 999`, previously scoring coverageRate 1.0 with complete: true.
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'demo',
    total: 1,
    documents: F3_DOCUMENTS,
    findings: [{
      id: 'liar',
      path: 'src/does-not-exist.ts',
      start: 999,
      anchored: true,
      severity: 'high',
      message: '这条发现声称自己已锚定',
      evidence: 'const real = 1',
      defended: true,
    }],
  }, {})

  assert.equal(submitted.unanchored, 1, 'the self-report must be discarded')
  assert.equal(submitted.findings.length, 0, 'an unanchored finding is not an effective finding')
  assert.equal(submitted.coverage.reviewed, 0)
  assert.equal(submitted.coverage.coverageRate, 0)
  assert.equal(submitted.coverage.complete, false, 'complete:true for a nonexistent path is the bug F3 names')
  assert.equal(submitted.anchorVia, 'anchorVerifier')
  assert.equal(submitted.unanchoredDetails[0].id, 'liar')
  assert.notEqual(submitted.unanchoredDetails[0].detail, null)
})

await testAsync('submit keeps a finding the domain verifier DOES confirm, and ignores its declared line', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'demo',
    total: 2,
    documents: F3_DOCUMENTS,
    findings: [
      // start is a LIE (999); the verifier recomputes the true line (2).
      { id: 'honest', path: 'src/real.ts', start: 999, severity: 'high', message: 'm', evidence: 'const other = 2', defended: true },
    ],
  }, {})

  assert.equal(submitted.unanchored, 0)
  assert.equal(submitted.findings.length, 1)
  assert.equal(submitted.findings[0].path, 'src/real.ts')
  assert.equal(submitted.findings[0].start, 2, 'the RECOMPUTED line wins over the declared 999')
  assert.equal(submitted.findings[0].anchorVia, 'anchorVerifier')
  assert.equal(submitted.coverage.reviewed, 1)
})

await testAsync('the coverage denominator cannot be shrunk below what the engine admitted', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  // The engine admits 4 candidates at plan time…
  const candidates = [
    { path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }, { path: 'src/d.ts' },
  ]
  const plan = await ctx.__tools.get('adjudication_plan').execute({ domain: 'demo', target: 'same target', candidates }, {})
  assert.equal(plan.gate.admitted, 4)

  // …so a caller declaring total: 1 cannot inflate the rate.
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'demo',
    target: 'same target',
    total: 1,
    documents: F3_DOCUMENTS,
    findings: [{ id: 'one', path: 'src/real.ts', start: 2, severity: 'high', message: 'm', evidence: 'const other = 2', defended: true }],
  }, {})

  assert.equal(submitted.coverage.total, 4, 'the plan admitted 4; a smaller declared total must not win')
  assert.equal(submitted.coverage.totalSource, 'plan')
  assert.equal(submitted.coverage.declaredTotal, 1)
  assert.equal(submitted.coverage.raisedAboveDeclared, true)
  assert.equal(submitted.coverage.reviewed, 1)
  assert.equal(submitted.coverage.coverageRate, 0.25)
})

await testAsync('the coverage denominator is at least the number of anchors the engine could establish', async () => {
  const files = domainFiles('domains/demo', 'demo')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'demo',
    total: 0,
    documents: F3_DOCUMENTS,
    findings: [{ id: 'one', path: 'src/real.ts', start: 2, severity: 'high', message: 'm', evidence: 'const other = 2', defended: true }],
  }, {})

  assert.equal(submitted.coverage.total, 1, 'a zero denominator would report an infinite rate')
  assert.equal(submitted.coverage.totalSource, 'anchored-count')
  assert.equal(submitted.coverage.coverageRate, 1)
})

// ---------------------------------------------------------------------------
console.log('\n9. F3 passthrough — the caller\'s claim reaches the verifier intact')
// ---------------------------------------------------------------------------

// CHANGED (t49): every fixture in this section returns `declared-locator`, not
// the removed `domain-locator`. This is a RENAME, not a relaxation: the
// assertions below still require a non-line locator to produce a TRUSTED tier,
// to anchor, to keep the finding, and to count towards coverage — they now use
// the name that all nineteen shipped verifiers use for exactly this verdict
// (the removed tier's own documentation said its semantics EQUAL
// `declared-locator`). `lib/contracts.js`'s note on TRUSTED_ANCHOR_TIERS carries
// the measurement; §16 below is the guard that keeps it from coming back.

/**
 * A v2 directory pack whose anchor verifier is supplied by the test, so the test
 * can see exactly what the engine handed it.
 */
function shapeDomain(directory, id, verify) {
  const files = domainFiles(directory, id)
  files[`${directory}/anchor.js`] = {
    default: { __contract: CONTRACT_VERSION, kind: `${id}-anchor`, verify },
  }
  return files
}

function submitVia(ctx, args) {
  return ctx.__tools.get('adjudication_submit').execute(args, {})
}

await testAsync('passthrough 1/3: the LINE-NUMBER family still gets locator.startLine', async () => {
  // code-review's shape: `{hunkIndex, startLine, endLine}`. Its behaviour must be
  // byte-for-byte what it was before the passthrough change.
  const seen = []
  const files = shapeDomain('domains/lines', 'lines', (claim) => {
    seen.push(claim)
    if (claim?.locator?.startLine === 2) {
      return { status: 'anchored', tier: 'declared-locator', path: claim.path, start: 2, end: 2, detail: '行号确认' }
    }
    return { status: 'unanchored', tier: 'locator-mismatch', path: null, start: null, end: null, detail: '行号不符' }
  })
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const submitted = await submitVia(ctx, {
    domain: 'lines',
    total: 1,
    documents: F3_DOCUMENTS,
    findings: [{ id: 'l1', path: 'src/real.ts', start: 2, severity: 'high', message: 'm', evidence: 'const other = 2', defended: true }],
  })

  assert.equal(submitted.unanchored, 0)
  assert.equal(submitted.findings.length, 1)
  assert.equal(submitted.findings[0].anchorTier, 'declared-locator')
  assert.equal(seen.length, 1, 'the verifier must run exactly once')
  assert.equal(seen[0].kind, 'lines-anchor')
  assert.equal(seen[0].path, 'src/real.ts')
  assert.equal(seen[0].locator.startLine, 2, 'the convenience `start` must still feed the line family')
  assert.equal(seen[0].excerpt, 'const other = 2')
})

await testAsync('passthrough 2/3: ID-shaped and GRAPH-shaped locators arrive verbatim', async () => {
  // The defect: `recomputeAnchor` used to build `{start, startLine, end, endLine}`
  // and drop everything else, so sixteen of the nineteen declared locator shapes
  // reached their own verifier as an empty claim.
  const seen = []
  const files = shapeDomain('domains/shapes', 'shapes', (claim, subject) => {
    seen.push({ claim, subject })
    const locator = claim?.locator ?? {}
    if (locator.clauseId === 'C-3.2' && locator.surfaceId === 'S-01') {
      return { status: 'anchored', tier: 'declared-locator', path: claim.path, locator: { ...locator }, detail: '条款确认' }
    }
    if (locator.kind === 'task-edge' && locator.taskId === 'T-1' && locator.from === 'A' && locator.to === 'B') {
      if (subject?.document?.payload?.graph?.edges?.length === 1) {
        return { status: 'anchored', tier: 'declared-locator', path: claim.path, locator: { ...locator }, detail: '图边确认' }
      }
      return { status: 'unanchored', tier: 'no-match', path: null, start: null, end: null, detail: '文档的领域载荷被压掉了' }
    }
    return {
      status: 'unanchored',
      tier: 'kind-mismatch',
      path: null,
      start: null,
      end: null,
      detail: `不认识的 locator 键：${Object.keys(locator).join(',') || '(空)'}`,
    }
  })
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  // (a) ID shape — risk-compliance's `{clauseId, surfaceId}`.
  const clause = await submitVia(ctx, {
    domain: 'shapes',
    total: 1,
    documents: [{ path: 'clause/C-3.2', content: '第 3.2 条 要求……' }],
    findings: [{
      id: 'c1',
      path: 'clause/C-3.2',
      locator: { clauseId: 'C-3.2', surfaceId: 'S-01' },
      severity: 'high',
      message: 'm',
      evidence: '第 3.2 条 要求……',
      defended: true,
    }],
  })
  assert.equal(clause.unanchored, 0, JSON.stringify(clause.unanchoredDetails))
  assert.equal(clause.findings[0].anchorTier, 'declared-locator')
  assert.equal(seen.length, 1)
  assert.deepEqual(
    Object.keys(seen[0].claim.locator).sort(),
    ['clauseId', 'surfaceId'],
    'the engine must neither drop domain keys nor inject its own',
  )

  // (b) Graph shape — project-management's `{taskId, from, to}` plus a
  // domain-defined `locator.kind` that its verifier reads.
  seen.length = 0
  const graph = await submitVia(ctx, {
    domain: 'shapes',
    total: 1,
    documents: [{ path: 'graph/tasks.json', content: '{}', payload: { graph: { edges: [{ from: 'A', to: 'B' }] } } }],
    findings: [{
      id: 'g1',
      path: 'graph/tasks.json',
      locator: { kind: 'task-edge', taskId: 'T-1', from: 'A', to: 'B' },
      severity: 'high',
      message: 'm',
      evidence: 'edge A->B',
      defended: true,
    }],
  })
  assert.equal(graph.unanchored, 0, JSON.stringify(graph.unanchoredDetails))
  assert.equal(graph.findings[0].anchorTier, 'declared-locator', 'the domain document payload must survive toDocuments')
  assert.equal(seen[0].claim.locator.kind, 'task-edge', 'locator.kind is read by the verifier and must arrive')
  assert.equal(seen[0].subject.document.payload.graph.edges.length, 1)
  assert.deepEqual(graph.findings[0].anchorLocator, { kind: 'task-edge', taskId: 'T-1', from: 'A', to: 'B' })
})

await testAsync('passthrough 3/3: passthrough is NOT a free pass — a wrong locator is rejected', async () => {
  const seen = []
  const files = shapeDomain('domains/strict', 'strict', (claim) => {
    seen.push(claim)
    const locator = claim?.locator ?? {}
    if (locator.clauseId === 'C-3.2' && locator.surfaceId === 'S-01') {
      return { status: 'anchored', tier: 'declared-locator', path: claim.path, locator: { ...locator }, detail: '条款确认' }
    }
    return { status: 'unanchored', tier: 'kind-mismatch', path: null, start: null, end: null, detail: '找不到该条款' }
  })
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const submitted = await submitVia(ctx, {
    domain: 'strict',
    total: 1,
    documents: [{ path: 'clause/C-3.2', content: '第 3.2 条 要求……' }],
    findings: [{
      id: 'bad',
      path: 'clause/C-3.2',
      locator: { clauseId: 'C-999', surfaceId: 'S-99' },
      severity: 'high',
      message: 'm',
      evidence: '第 3.2 条 要求……',
      defended: true,
      anchored: true,
    }],
  })

  assert.equal(submitted.unanchored, 1, 'a claim the verifier rejects cannot be anchored by self-report')
  assert.equal(submitted.findings.length, 0)
  assert.equal(submitted.coverage.complete, false)
  assert.equal(submitted.coverage.reviewed, 0)
  assert.equal(submitted.unanchoredDetails[0].tier, 'kind-mismatch')
})

await testAsync('an anchored verdict may carry a domain locator instead of a line range', async () => {
  const files = domainFiles('domains/oracle', 'oracle')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  // Direct contract check for the widened anchored shape: the ID/graph families
  // legitimately have no line number, and the old validator made every one of
  // their honest verdicts illegal.
  assert.deepEqual(
    validateAnchorVerdict({ status: 'anchored', tier: 'declared-locator', path: 'clause/C-3.2', locator: { clauseId: 'C-3.2' } }),
    [],
  )
  assert.equal(validateAnchorVerdict({ status: 'anchored', tier: 'declared-locator', path: 'x' }).length, 1,
    'a verdict with neither a range nor a locator is still illegal')
  assert.deepEqual(
    validateAnchorVerdict({ status: 'anchored', tier: 'declared-locator', path: 'a.ts', start: 2, end: 2 }),
    [],
    'the line-shaped path is unchanged',
  )
  assert.equal(validateAnchorVerdict({ status: 'anchored', tier: 'declared-locator', path: 'a.ts', start: 0, end: 0 }).length, 1)
  void ctx
})

await testAsync('P0 passthrough: a candidate keeps the fields its bundleKey and gate read', async () => {
  // Same defect class as the locator/documents losses: `planFor()` ran the
  // lossy caller-shorthand coercion over the candidateSource's OWN output, so a
  // graph/clause/flow candidate reached `bundleKey.resolve` with its `locator`
  // stripped and every such domain silently bundled by path.
  const files = domainFiles('domains/graph', 'graph', {
    pack: { bundleKey: { strategy: 'path', resolve: (candidate) => (candidate?.locator === undefined ? 'LOCATOR-LOST' : 'locator-kept') } },
  })
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const viaSource = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'graph',
    target: 'graph via source',
    input: { format: 'demo-input', payload: { items: [{ path: 'ws/a' }, { path: 'ws/b' }, { path: 'ws/c' }, { path: 'ws/d' }] } },
  }, {})
  assert.equal(viaSource.candidateSet.origin, 'candidateSource')
  assert.equal(viaSource.bundleKey.source, 'derived')
  assert.equal(viaSource.bundles.length, 1)
  assert.equal(viaSource.bundles[0].key, 'locator-kept', 'candidateSource output must reach bundleKey.resolve intact')

  const viaCaller = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'graph',
    target: 'graph via caller',
    candidates: [
      { path: 'ws/a', locator: { index: 0 } },
      { path: 'ws/b', locator: { index: 1 } },
      { path: 'ws/c', locator: { index: 2 } },
      { path: 'ws/d', locator: { index: 3 } },
    ],
  }, {})
  assert.equal(viaCaller.bundleKey.source, 'derived')
  assert.equal(viaCaller.bundles[0].key, 'locator-kept', 'caller-supplied candidates keep their extra fields too')
})

await testAsync('the P4 prompt context carries the bundle VERBATIM, domain fields included', async () => {
  // Instance #4 of the "reconstruct domain-shaped data from a fixed key set"
  // defect class. `lib/reasoner.js` used to build the context bundle as
  // `{ key, paths, rules }`, so a domain's own `reviewPrompts.review(context)`
  // could not read the bundle fields its `bundleKey.resolve` had just produced.
  // The rule is now "spread, then default" — add convenience keys if missing,
  // never discard what the caller sent.
  const seen = []
  const pack = {
    id: 'demo',
    title: '演示领域',
    lossOrientation: 'precision-first',
    reviewPrompts: {
      review: (context) => {
        seen.push(context)
        return { system: `P4：${context?.bundle?.streamKey ?? '(缺)'}`, rules: context?.bundle?.ruleText }
      },
      verify: () => ({ system: 'P6', instructions: 'i' }),
    },
  }
  const fake = fakeSubagents()
  const reasoner = createReasoner({ subagents: fake.service })

  const outcome = await reasoner.run({
    pack,
    target: 't',
    bundles: [{
      key: 'ws/cart',
      paths: ['ws/cart/a.json'],
      rules: ['r1'],
      ruleText: '规则正文',
      // A domain-defined field the engine has never heard of.
      streamKey: '购物车工作流',
      entries: [{ path: 'ws/cart/a.json', locator: { kind: 'ws/cart' } }],
    }],
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.prompts[0].source, 'reviewPrompts')
  assert.equal(seen.length, 1, 'the domain prompt must have been asked for its text')
  assert.equal(seen[0].bundle.streamKey, '购物车工作流', 'the domain field must survive into the prompt context')
  assert.equal(seen[0].bundle.key, 'ws/cart')
  assert.deepEqual(seen[0].bundle.paths, ['ws/cart/a.json'])
  assert.equal(seen[0].bundle.ruleText, '规则正文')
  // The convenience keys are still there, exactly as before this change.
  assert.deepEqual(seen[0].bundle.rules, ['r1'])
  assert.equal(seen[0].ruleText, '规则正文')
  // `context.candidates` used to read a key that nothing ever set, so it was
  // always []. It now falls back to the bundle's entries.
  assert.equal(seen[0].candidates.length, 1)
  assert.equal(seen[0].candidates[0].path, 'ws/cart/a.json')
  assert.equal(seen[0].candidates[0].locator.kind, 'ws/cart')
  // And the text the domain returned is what actually got sent.
  assert.match(fake.calls[0].prompt[0].text ?? JSON.stringify(fake.calls[0].prompt), /购物车工作流/u)
})

// ---------------------------------------------------------------------------
console.log('\n10. KNOWN BOUNDARY — normalizeLine strips a diff marker only at column 0')
// ---------------------------------------------------------------------------

test('KNOWN BOUNDARY: the marker strip is position-0 only, so line and quote must agree on it', () => {
  // `normalizeLine` is `/^[+-]/` + whitespace removal. `^` matches the FIRST
  // character ONLY, so a line whose own text begins with `-`/`+` (CSS custom
  // property `--x`, YAML `- x`, Markdown bullet, leading arithmetic) has its
  // comparison form decided by whether a marker sits at column 0 — and the
  // document line and the quoted excerpt need not agree on that. The documented
  // tolerance "diff markers may be ignored" therefore holds in ONE DIRECTION
  // ONLY for such lines.
  //
  // This is a RECALL loss, never a precision loss. It is a decision, not an
  // oversight: it reproduces the upstream rule the reference domain exists to
  // stay comparable with, `normalizeLine` has 13 independent copies across 12
  // domains (none of which imports this one), and the ladder trades recall for
  // precision by design. Recorded, with the copy-variant table and the
  // "converge to a single shared implementation" debt, in
  // docs/domain-contract-v2.md §1.2 "已知边界" / "结构债". Change it THERE first.

  // (a) The primitive itself. Same content, different column-0 marker count.
  assert.equal(normalizeLine('--focus-ring: x;'), '-focus-ring:x;')
  assert.equal(normalizeLine('  --focus-ring: x;'), '--focus-ring:x;')
  assert.notEqual(
    normalizeLine('  --focus-ring: x;'), normalizeLine('--focus-ring: x;'),
    'the same source line normalises differently with and without leading indentation',
  )
  assert.notEqual(
    normalizeLine('+--focus-ring: x;'), normalizeLine('--focus-ring: x;'),
    'a +-marked quote and an unmarked quote of the same source line are NOT equal',
  )

  // (b) An ordinary line is unaffected: all three spellings collapse.
  for (const spelling of ['color: red;', '  color: red;', '+\tcolor: red;']) {
    assert.equal(normalizeLine(spelling), 'color:red;', `ordinary line ${JSON.stringify(spelling)}`)
  }

  // (c) End to end through the engine's own ladder (`anchorInDocument` is the
  // window `resolveAnchor` walks, and it is what the 12 domain copies of
  // `normalizeLine` are used by).
  const css = 'a {\n  --focus-ring: 0 0 0 2px var(--accent);\n  color: red;\n}\n'
  assert.equal(anchorInDocument('--focus-ring: 0 0 0 2px var(--accent);', css).status, 'unanchored')
  assert.equal(anchorInDocument('+--focus-ring: 0 0 0 2px var(--accent);', css).status, 'anchored')
  assert.equal(anchorInDocument('--focus-ring: 0 0 0 2px var(--accent);', css).tier, 'no-match')
  assert.equal(anchorInDocument('+\tcolor:  red;', css).start, 3)

  // (d) Precision is untouched — the paraphrase of the same line is still
  // refused, so this boundary can never be read as "near misses are allowed".
  assert.equal(anchorInDocument('+--focus-ring: 0 0 0 2px var(--accent); /* tuned */', css).status, 'unanchored')

  // (e) And the relocation ladder inherits it, identically.
  const relocated = resolveAnchor('--focus-ring: 0 0 0 2px var(--accent);', [{ path: 'src/a.css', content: css }], 'src/a.css')
  assert.equal(relocated.status, 'unanchored')
  assert.equal(baseTier(relocated), 'no-match')
})

/**
 * `resolveAnchor` returns `no-match`-family tiers with no `tier` field on some
 * paths; read whichever spelling the ladder used so the assertion stays about
 * behaviour rather than about a field name.
 */
function baseTier(verdict) {
  return verdict.tier ?? verdict.reason ?? 'no-match'
}

// ---------------------------------------------------------------------------
console.log('\n11. F2 — `subject.candidates` is a contract promise, and it is kept')
// ---------------------------------------------------------------------------

/**
 * An ID-family domain pack: its structural half lives in the ENUMERATED
 * candidate set, not in the documents.
 *
 * This is the shape `risk-compliance` (`{clauseId, surfaceId}` bindings),
 * `ux-review` (`{branchId, stepId}` membership), `ui-visual`
 * (`{layerId, prop, tokenName}` triples), `architecture` (`{moduleId,targetId}`
 * edges) and `project-management` (`{taskId, from, to}`) all have: the fact a
 * claim asserts about is one the domain's own `source.js` already enumerated
 * from the caller's input, and the verifier recomputes the claim against that
 * enumeration instead of trusting the claim.
 *
 * `docs/domain-contract-v2.md` §1.2 declares `subject.candidates` for exactly
 * this purpose ("P0 产出，locator 空间在这里") and the engine never supplied it.
 * `seen` records every subject the verifier was handed, so the assertions can
 * distinguish "the engine passed the enumeration through" from "the engine
 * invented an equivalent-looking structure".
 */
function idFamilyDomain(directory, id, seen) {
  const files = domainFiles(directory, id)
  files[`${directory}/source.js`] = {
    default: {
      __contract: CONTRACT_VERSION,
      kind: `${id}-candidates`,
      inputFormat: 'demo-input',
      bounded: true,
      enumerate: (input) => ({
        candidates: (Array.isArray(input?.nodes) ? input.nodes : []).map((node) => ({
          id: `${id}:${node.nodeId}`,
          path: `graph/${node.nodeId}`,
          locator: { nodeId: node.nodeId },
          text: node.text ?? 'node',
          // A field the engine has never heard of. If the engine ever rebuilt
          // these objects from a fixed key set, this is what would vanish.
          meta: { fromSource: true, nodeId: node.nodeId },
        })),
        excluded: [],
        notes: [],
        bounded: true,
        truncated: false,
      }),
    },
  }
  files[`${directory}/anchor.js`] = {
    default: {
      __contract: CONTRACT_VERSION,
      kind: `${id}-anchor`,
      verify: (claim, subject) => {
        seen.push(subject)
        const content = typeof subject?.content === 'string' ? subject.content : ''
        const excerpt = String(claim?.excerpt ?? '')
        const nodeId = claim?.locator?.nodeId
        // The structural half: the claimed node must be one the domain itself
        // enumerated. Without `subject.candidates` this can never be satisfied.
        const enumerated = Array.isArray(subject?.candidates) ? subject.candidates : null
        if (enumerated === null) {
          return { status: 'unanchored', tier: 'no-documents', path: null, start: null, end: null, detail: '没有候选集，结构侧无法重算' }
        }
        if (!enumerated.some((c) => c?.locator?.nodeId === nodeId)) {
          return { status: 'unanchored', tier: 'no-match', path: null, start: null, end: null, detail: `候选集里没有节点 "${String(nodeId)}"` }
        }
        const lines = content.split('\n')
        const at = lines.indexOf(excerpt) + 1
        if (excerpt === '' || at === 0) {
          return { status: 'unanchored', tier: 'no-match', path: null, start: null, end: null, detail: '原文未命中' }
        }
        return { status: 'anchored', tier: 'declared-locator', path: claim.path, start: at, end: at, locator: { nodeId }, detail: `节点 ${String(nodeId)} 已在候选集中确认` }
      },
    },
  }
  return files
}

const ID_PAYLOAD = { nodes: [{ nodeId: 'n1' }, { nodeId: 'n2' }] }
const ID_DOCUMENTS = [{ path: 'graph/n1', content: 'alpha\nbeta\n' }]

await testAsync('F2: an ID-family domain anchors through a real plan + submit', async () => {
  const seen = []
  const files = idFamilyDomain('domains/ids', 'ids', seen)
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const plan = await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ids', target: 'graph', input: { format: 'demo-input', payload: ID_PAYLOAD },
  }, {})
  assert.equal(plan.gate.admitted, 2, 'both enumerated nodes were admitted')

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'ids',
    documents: ID_DOCUMENTS,
    findings: [{ id: 'f1', path: 'graph/n1', locator: { nodeId: 'n1' }, evidence: 'beta', severity: 'high', message: 'm', defended: true }],
  }, {})

  assert.equal(submitted.anchorVia, 'anchorVerifier')
  assert.equal(submitted.findings.length, 1, 'the finding is anchored and therefore kept')
  assert.equal(submitted.findings[0].anchored, true)
  assert.equal(submitted.findings[0].anchorTier, 'declared-locator')
  assert.equal(submitted.findings[0].start, 2, 'the line came from the domain verifier, not the caller')
  assert.equal(submitted.coverage.reviewed, 1, 'and it counts towards coverage')
  assert.equal(submitted.coverage.total, 2, 'the denominator is still the plan admission count')
  assert.equal(submitted.coverage.coverageRate, 0.5)

  // The verifier really received the domain's OWN enumeration.
  assert.equal(seen.length, 1)
  assert.equal(Array.isArray(seen[0].candidates), true, 'subject.candidates was supplied')
  assert.equal(seen[0].candidates.length, 2)
  assert.equal(seen[0].candidates[0].meta.fromSource, true, 'the candidate is the source module object, verbatim')
  assert.equal(seen[0].candidates[0].locator.nodeId, 'n1')
  assert.equal(seen[0].path, 'graph/n1', 'and the rest of the subject is unchanged')
  assert.equal(seen[0].content, 'alpha\nbeta\n')
})

await testAsync('F2: a claim about a node the enumeration does not contain is refused', async () => {
  const seen = []
  const files = idFamilyDomain('domains/ids', 'ids', seen)
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  await ctx.__tools.get('adjudication_plan').execute({
    domain: 'ids', input: { format: 'demo-input', payload: ID_PAYLOAD },
  }, {})

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'ids',
    documents: ID_DOCUMENTS,
    findings: [{ id: 'liar', path: 'graph/n1', locator: { nodeId: 'n9' }, evidence: 'beta', severity: 'high', message: 'm', defended: true }],
  }, {})

  assert.equal(submitted.findings.length, 0, 'no node "n9" was ever enumerated, so nothing is anchored')
  assert.equal(submitted.unanchored, 1)
  assert.equal(submitted.unanchoredDetails[0].tier, 'no-match')
  assert.equal(submitted.coverage.reviewed, 0)
})

await testAsync('F2: with no plan, `candidates` is ABSENT rather than empty', async () => {
  // A verifier distinguishes "no candidate set was offered" (skip the binding
  // check) from "an empty one was offered" (nothing is bound to anything).
  // Risk-compliance's `toBindings` does exactly that, so the engine must not
  // hand it an empty array it never asked for.
  const seen = []
  const files = idFamilyDomain('domains/ids', 'ids', seen)
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'ids',
    documents: ID_DOCUMENTS,
    findings: [{ id: 'f1', path: 'graph/n1', locator: { nodeId: 'n1' }, evidence: 'beta' }],
  }, {})

  assert.equal(seen.length, 1)
  assert.equal(Object.hasOwn(seen[0], 'candidates'), false, 'unknown means absent, not empty')
  assert.equal(submitted.findings.length, 0, 'and this verifier correctly refuses without it')
  assert.equal(submitted.unanchoredDetails[0].tier, 'no-documents')

  // ...and the caller can supply it directly, without a plan.
  const withCandidates = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'ids',
    documents: ID_DOCUMENTS,
    candidates: [{ id: 'c1', path: 'graph/n1', locator: { nodeId: 'n1' } }],
    findings: [{ id: 'f1', path: 'graph/n1', locator: { nodeId: 'n1' }, evidence: 'beta', severity: 'high', message: 'm', defended: true }],
  }, {})
  assert.equal(withCandidates.findings.length, 1, 'an explicitly supplied candidate set anchors the finding')
  assert.equal(withCandidates.findings[0].anchorTier, 'declared-locator')
  assert.equal(Object.hasOwn(seen[1], 'candidates'), true)
  assert.equal(seen[1].candidates[0].id, 'c1', 'handed over verbatim, no engine-invented fields')
})

await testAsync('F2: `adjudication_anchor` accepts the candidate set explicitly', async () => {
  const seen = []
  const files = idFamilyDomain('domains/ids', 'ids', seen)
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const withoutCandidates = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'ids', path: 'graph/n1', locator: { nodeId: 'n1' }, excerpt: 'beta', documents: ID_DOCUMENTS,
  }, {})
  assert.equal(withoutCandidates.status, 'unanchored')
  assert.equal(withoutCandidates.tier, 'no-documents')
  assert.equal(withoutCandidates.via, 'anchorVerifier')

  const withCandidates = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'ids', path: 'graph/n1', locator: { nodeId: 'n1' }, excerpt: 'beta', documents: ID_DOCUMENTS,
    candidates: [{ id: 'c1', path: 'graph/n1', locator: { nodeId: 'n1' } }],
  }, {})
  assert.equal(withCandidates.status, 'anchored')
  assert.equal(withCandidates.start, 2)
  assert.equal(withCandidates.via, 'anchorVerifier')

  // The anchor tool also picks up a previous plan's enumeration.
  await ctx.__tools.get('adjudication_plan').execute({ domain: 'ids', input: { format: 'demo-input', payload: ID_PAYLOAD } }, {})
  const afterPlan = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'ids', path: 'graph/n1', locator: { nodeId: 'n2' }, excerpt: 'beta', documents: ID_DOCUMENTS,
  }, {})
  assert.equal(afterPlan.status, 'anchored', 'n2 came from the plan, not from the call')
})

// ---------------------------------------------------------------------------
console.log('\n12. t37 — TWO DECLARATIONS THAT USED TO BE INERT')
// ---------------------------------------------------------------------------

/**
 * A KIND-CHECKING domain. Its verifier refuses a claim whose `kind` is not its
 * own — the shape every one of the four audited domains has (`kind-mismatch`).
 *
 * Before t37 this check could never fire through the tool: `recomputeAnchor`
 * computed `kind` from the pack and never read `args.kind`, so the claim always
 * arrived wearing the pack's kind. The negative case was reproducible only by
 * calling `verify` directly, and the plugin path answered `no-documents`
 * instead of `kind-mismatch` — the one fold-path difference left in the program.
 */
function kindCheckingDomain(directory, id) {
  const files = domainFiles(directory, id)
  files[`${directory}/anchor.js`] = {
    default: {
      __contract: CONTRACT_VERSION,
      kind: `${id}-anchor`,
      verify: (claim, subject) => {
        if (claim?.kind !== `${id}-anchor`) {
          return {
            status: 'unanchored', tier: 'kind-mismatch', code: 'kind-mismatch',
            path: null, start: null, end: null,
            detail: `声明的是 ${String(claim?.kind)}，本领域只认 ${id}-anchor`,
          }
        }
        return subject?.content === 'the real line'
          ? { status: 'anchored', tier: 'recomputed-unique', code: 'line-confirmed', path: claim.path, start: 1, end: 1, detail: '逐字命中' }
          : { status: 'unanchored', tier: 'no-match', code: 'no-match', path: null, start: null, end: null, detail: '没有命中' }
      },
    },
  }
  return files
}

const KIND_DOCUMENTS = [{ path: 'src/real.txt', content: 'the real line' }]

await testAsync('adjudication_anchor passes the caller-supplied `kind` THROUGH to the verifier', async () => {
  const files = kindCheckingDomain('domains/kindly', 'kindly')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  // 1. An explicit, foreign kind must reach the verifier — and be visible in the
  //    claim that was judged. t24-F5 measured the opposite: this call returned
  //    the pack's kind and a verdict computed against payload the claim was never
  //    about.
  const foreign = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'kindly', excerpt: 'the real line', path: 'src/real.txt', documents: KIND_DOCUMENTS,
    kind: 'some-other-kind',
  }, {})
  assert.equal(foreign.claim.kind, 'some-other-kind', 'the judged claim must carry the kind the caller declared')
  assert.equal(foreign.status, 'unanchored')
  assert.equal(foreign.tier, 'kind-mismatch')
  assert.equal(foreign.code, 'kind-mismatch')
  assert.equal(foreign.via, 'anchorVerifier')

  // 2. Omitting it still means "use the domain's declared kind" — the documented
  //    default, and what `adjudication_submit` relies on (findings carry no kind).
  const declared = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'kindly', excerpt: 'the real line', path: 'src/real.txt', documents: KIND_DOCUMENTS,
  }, {})
  assert.equal(declared.claim.kind, 'kindly-anchor')
  assert.equal(declared.status, 'anchored', 'the default kind must not become a mismatch')

  // 3. The caller's kind is what the verifier SEES, so this is not a display-only
  //    fix: passing the domain's own kind explicitly is accepted verbatim.
  const explicit = await ctx.__tools.get('adjudication_anchor').execute({
    domain: 'kindly', excerpt: 'the real line', path: 'src/real.txt', documents: KIND_DOCUMENTS,
    kind: 'kindly-anchor',
  }, {})
  assert.equal(explicit.status, 'anchored')
  assert.equal(explicit.start, 1)
})

await testAsync('the documented `kind` parameter is no longer a silent no-op', async () => {
  // The regression is "two different inputs produce byte-identical output".
  // Comparing the two verdicts directly is what makes that impossible to
  // reintroduce: the old implementation passed this test's _shape_ (a verdict
  // came back) while failing its point (the verdict ignored the input).
  const files = kindCheckingDomain('domains/kindly2', 'kindly2')
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const args = {
    domain: 'kindly2', excerpt: 'the real line', path: 'src/real.txt', documents: KIND_DOCUMENTS,
  }
  const withoutKind = await ctx.__tools.get('adjudication_anchor').execute(args, {})
  const withForeignKind = await ctx.__tools.get('adjudication_anchor').execute({ ...args, kind: 'not-this-domain' }, {})
  assert.notDeepEqual(
    { status: withForeignKind.status, tier: withForeignKind.tier, code: withForeignKind.code },
    { status: withoutKind.status, tier: withoutKind.tier, code: withoutKind.code },
    'supplying a different kind MUST change the verdict; identical output is the t24-F5 defect',
  )
  assert.equal(withoutKind.status, 'anchored')
  assert.equal(withForeignKind.code, 'kind-mismatch')

  // And the tool description promised exactly this, so it is now true.
  const tool = ctx.__tools.get('adjudication_anchor')
  assert.match(String(tool.parameters?.properties?.kind?.description ?? ''), /按传入的 kind 核验/u)
})

await testAsync('evidence tools ENFORCE their declared maxCalls (per activation, not per process)', async () => {
  const files = domainFiles('domains/capped', 'capped')
  files['domains/capped/evidence.js'] = {
    default: {
      __contract: CONTRACT_VERSION,
      tools: [{
        name: 'peek',
        description: '偷看一条候选',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' } },
        limits: { maxLines: 10, maxItems: 5, maxCalls: 2 },
        execute: () => ({ items: [{ line: 'x' }], truncated: false, provenance: 'capped' }),
      }],
    },
  }
  const ctx = createContext(PROMPT_SERVICE)
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  const peek = 'adjudicate_capped_evidence_peek'

  await ctx.__tools.get('adjudication_activate').execute({ domain: 'capped' }, {})
  assert.equal((await ctx.__tools.get(peek).execute({}, {})).items.length, 1, 'call 1 of 2')
  assert.equal((await ctx.__tools.get(peek).execute({}, {})).items.length, 1, 'call 2 of 2')

  // The declaration said `maxCalls: 2`. Before t37 this call succeeded, which
  // made the declaration a number that bounded nothing.
  await assert.rejects(
    () => ctx.__tools.get(peek).execute({}, {}),
    (error) => {
      assert.equal(error?.code, 'E_BUDGET_EXHAUSTED')
      assert.match(String(error?.message), /maxCalls=2/u, 'the refusal must quote the declaration it enforced')
      return true
    },
  )

  // Per ACTIVATION: re-activating starts a fresh budget, so a review is not
  // permanently poisoned by an earlier one. This is the difference between the
  // per-tool counter (here) and the ledger's per-run `maxToolCalls`.
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'capped' }, {})
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'capped' }, {})
  assert.equal((await ctx.__tools.get(peek).execute({}, {})).items.length, 1, 'a fresh activation restores the budget')
})

// ---------------------------------------------------------------------------
console.log('\n13. t37 — `selectRules().unmapped` means what its name claims')
// ---------------------------------------------------------------------------

test('a multi-path bundle where EVERY path matches a rule family reports NOTHING unmapped', () => {
  // The t30 counterexample, verbatim: three paths, two rules of one family that
  // all match every `.json` path. The old implementation removed ONE path per
  // rule, so it reported ['p/two.json','p/three.json'] — a warning that fires on
  // essentially every multi-path bundle, i.e. a signal with no information.
  const family = (name) => ({ name, match: ['**/experiments/**', '**/*.json'], text: `${name} 的正文` })
  const paths = ['p/one.json', 'p/two.json', 'p/three.json']
  const result = selectRules([family('r1'), family('r2')], paths)

  assert.equal(result.injected.length, 2, 'both rules match the family')
  assert.deepEqual(result.unmapped, [], 'nothing is unmapped when every path matched')
})

test('unmapped still reports paths that NO injected rule matched', () => {
  // The fix must not turn the field into a constant: the honest signal is the
  // path that fell outside every rule's globs.
  const rules = [{ name: 'only-sql', match: ['**/*.sql'], text: '只针对 SQL' }]
  const result = selectRules(rules, ['models/a.sql', 'notes/readme.md'])
  assert.deepEqual(result.injected.map((rule) => rule.name), ['only-sql'])
  assert.deepEqual(result.unmapped, ['notes/readme.md'])

  // Nothing matches at all: every path is unmapped, and that is not an error.
  assert.deepEqual(selectRules(rules, ['notes/readme.md']).unmapped, ['notes/readme.md'])
  // No paths: no claims.
  assert.deepEqual(selectRules(rules, []).unmapped, [])
})

test('a rule that is NOT injected cannot mark a path as mapped', () => {
  // Duplicate names never inject (declaration order, first match wins). Because
  // the marking now happens only for injected rules, a duplicate cannot quietly
  // silence the unmapped warning for globs no injected rule covers.
  const dup = (match) => ({ name: 'same-name', match, text: '正文' })
  const result = selectRules([dup(['**/*.json']), dup(['**/*.md'])], ['a.json', 'b.md'])
  assert.equal(result.injected.length, 1, 'the duplicate name is not a second injection')
  assert.deepEqual(result.unmapped, ['b.md'], 'only the injected rule\'s matches count')
})

// ---------------------------------------------------------------------------
console.log('\n14. t41 — P6 HAS A RUNTIME PATH, AND IT IS INDEPENDENT')
// ---------------------------------------------------------------------------

/** A v2 domain whose verdict carries attribution metadata — and junk P4 never sends. */
function p6Domain(directory, id, overrides = {}) {
  const files = domainFiles(directory, id)
  files[`${directory}/prompts.js`] = {
    default: {
      __contract: CONTRACT_VERSION,
      review: () => ({ system: `P4-SYSTEM-${id}`, rules: 'P4 规则正文' }),
      verify: () => ({ system: `P6-SYSTEM-${id}`, instructions: 'P6 说明：只看证据，不看重算过程' }),
    },
  }
  files[`${directory}/anchor.js`] = {
    default: {
      __contract: CONTRACT_VERSION,
      kind: `${id}-anchor`,
      verify: (claim, subject) => (subject?.content === 'the real line'
        ? {
          status: 'anchored', tier: 'declared-locator', code: 'line-confirmed',
          path: claim.path, start: 1, end: 1,
          locator: claim.locator,
          ref: 'feedback/fb-1', refDomain: 'user-feedback', refForm: 'feedback-row',
          refBasis: 'exact', refBasisDetail: 'F1 的形状唯一指向 user-feedback',
          // Junk a real verifier would never send, but a caller's finding could:
          ruleText: 'P4-规则原文-不该到 P6',
          workOrder: 'P4-本轮负责的追踪链-不该到 P6',
          p4Reasoning: 'P4-推理过程-不该到 P6',
          ...overrides.verdict,
        }
        : { status: 'unanchored', tier: 'no-match', path: null, start: null, end: null, detail: '未命中' }),
    },
  }
  return files
}

function p6Harness(id, directory, overrides = {}) {
  const files = p6Domain(directory, id, overrides)
  const fake = fakeSubagents({
    result: (request) => (/P6/.test(String(request.label))
      ? { stopReason: 'completed', structured: { verdicts: [{ id: 'f1', keep: false, reason: '复核判不通过' }] }, output: [] }
      : { stopReason: 'completed', structured: { findings: [] }, output: [] }),
  })
  const ctx = createContext({ subagents: fake.service, systemPrompt: { section: () => 0 } })
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  return { ctx, fake, files }
}

const P6_DOCUMENTS = [{ path: 'src/real.ts', content: 'the real line' }]
const P6_FINDING = {
  id: 'f1', path: 'src/real.ts', excerpt: 'the real line',
  severity: 'high', message: '锚得住的发现', evidence: 'the real line', defended: true,
}

await testAsync('adjudication_submit RENDERS and RUNS reviewPrompts.verify on the real path', async () => {
  const { ctx, fake } = p6Harness('p6', 'domains/p6')
  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'p6', total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})

  const verify = out.review?.verify
  assert.ok(verify !== undefined, 'the submit result must carry a machine-readable P6 outcome')
  assert.equal(verify.ran, true, 'P6 must actually run — it used to have no renderer at all')
  assert.equal(verify.mode, 'subagents')
  assert.equal(verify.prompt.source, 'reviewPrompts.verify', 'the DOMAIN text must be the one rendered')
  assert.equal(verify.rounds, 1, 'P6 is one pass, not one per bundle')
  assert.deepEqual(verify.verdicts, [{ id: 'f1', keep: false, reason: '复核判不通过' }])

  // It ran through a real child, with the P6 label and the P6 text.
  const call = fake.calls.find((entry) => /P6/.test(String(entry.label)))
  assert.ok(call !== undefined, 'a child must actually have been started for P6')
  const text = call.prompt.map((block) => block.text ?? '').join('')
  assert.match(text, /P6-SYSTEM-p6/u)
  assert.match(text, /P6 说明/u)
  assert.doesNotMatch(text, /P4-SYSTEM-p6/u, 'P6 must not be handed the P4 text')
})

await testAsync('P6 is handed ONLY the contract verify field set, and never P4 material', async () => {
  const { ctx, fake } = p6Harness('p6b', 'domains/p6b')
  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'p6b', total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})

  // (1) The context the prompt function saw is exactly PROMPT_CONTEXT_FIELDS.verify.
  assert.deepEqual(
    out.review.verify.contextFields,
    [...PROMPT_CONTEXT_FIELDS.verify],
    'the P6 context must be built key by key from the contract field set — no spread',
  )

  // (2) NEGATIVE proof: P4-only material is unreachable, even when the VERDICT
  //     carries it. Asserting "findings were passed in" would not catch this.
  const text = fake.calls.find((entry) => /P6/.test(String(entry.label))).prompt
    .map((block) => block.text ?? '').join('')
  for (const leaked of ['P4-规则原文-不该到 P6', 'P4-本轮负责的追踪链-不该到 P6', 'P4-推理过程-不该到 P6', 'P4 规则正文']) {
    assert.equal(text.includes(leaked), false, `"${leaked}" must not appear in the P6 prompt`)
  }
  const findingSeen = out.review.verify.contextFields.includes('findings')
  assert.equal(findingSeen, true, 'the findings ARE the P6 input')
  const renderedFindings = JSON.stringify(fake.calls.find((entry) => /P6/.test(String(entry.label))).prompt)
  assert.equal(renderedFindings.includes('workOrder'), false)
  assert.equal(renderedFindings.includes('ruleText'), false)
})

await testAsync('P6 gets NO domain evidence tools, and the filter is asserted rather than assumed', async () => {
  const files = p6Domain('domains/p6c', 'p6c')
  files['domains/p6c/evidence.js'] = {
    default: {
      __contract: CONTRACT_VERSION,
      tools: [{
        name: 'peek',
        description: '偷看一条候选',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' } },
        limits: { maxLines: 10, maxItems: 5, maxCalls: 4 },
        execute: () => ({ items: [], truncated: false, provenance: 'p6c' }),
      }],
    },
  }
  const fake = fakeSubagents({
    result: (request) => (/P6/.test(String(request.label))
      ? { stopReason: 'completed', structured: { verdicts: [] }, output: [] }
      : { stopReason: 'completed', structured: { findings: [] }, output: [] }),
  })
  const ctx = createContext({ subagents: fake.service, systemPrompt: { section: () => 0 } })
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'p6c', total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})

  assert.deepEqual(out.review.verify.toolFilter, { allow: [] }, 'P6 is sent an EXPLICIT empty allow list')
  const call = fake.calls.find((entry) => /P6/.test(String(entry.label)))
  assert.deepEqual(call.toolFilter, { allow: [] }, 'the child request itself must carry the filter')
  const allowed = call.toolFilter?.allow ?? []
  assert.equal(allowed.some((name) => String(name).includes('_evidence_')), false,
    'no domain evidence tool may be reachable from the independent re-check')
})

await testAsync('a v1 pack (no reviewPrompts) still gets a P6 pass, and it says which text it used', async () => {
  // The other half of the claim: P6 is not "connected for v2 packs only". A pack
  // with no prompts at all falls back to the legacy verify text, and the report
  // names that source instead of implying the domain's own text ran.
  const ctx = createContext({ subagents: fakeSubagents({ result: { stopReason: 'completed', structured: { verdicts: [{ id: 'f1', keep: true, reason: 'ok' }] }, output: [] } }).service })
  apply(ctx, { domainIo: createMemoryIo({}), loadModule: stubLoader({}) })
  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'code-review', total: 1, documents: P6_DOCUMENTS,
    findings: [P6_FINDING], target: 'v1 pack',
  }, {})
  assert.equal(out.review.verify.ran, true)
  assert.equal(out.review.verify.prompt.source, 'legacy-verify')
  assert.deepEqual(out.review.verify.contextFields, [...PROMPT_CONTEXT_FIELDS.verify])
})

await testAsync('the fold carries the domain verdict metadata P6 needs (and nothing else)', async () => {
  // t41: `requirement-alignment` renders `basis=<refBasis> refDomain=<refDomain>`
  // in its P6 text, and the engine's fold dropped both — measured over the whole
  // repository, `refDomain/refBasis/refBasisDetail` appeared in `index.js` and
  // `lib/*.js` ZERO times. Either half alone is useless, so this test drives the
  // real submit path with a domain whose P6 text READS the folded fields.
  const files = p6Domain('domains/p6d', 'p6d')
  files['domains/p6d/prompts.js'] = {
    default: {
      __contract: CONTRACT_VERSION,
      review: () => ({ system: 'P4-SYSTEM-p6d' }),
      verify: (context) => {
        const findings = Array.isArray(context?.findings) ? context.findings : []
        const basis = findings.map((finding) => `basis=${finding?.refBasis ?? '(未给出)'}，refDomain=${finding?.refDomain ?? '(未给出)'}，家族说明=${finding?.refBasisDetail ?? '(未给出)'}`)
        return { system: 'P6-SYSTEM-p6d', instructions: `归因档位（若给出）：${basis.join(' / ')}` }
      },
    },
  }
  const fake = fakeSubagents({
    result: (request) => (/P6/.test(String(request.label))
      ? { stopReason: 'completed', structured: { verdicts: [{ id: 'f1', keep: true, reason: 'ok' }] }, output: [] }
      : { stopReason: 'completed', structured: { findings: [] }, output: [] }),
  })
  const ctx = createContext({ subagents: fake.service, systemPrompt: { section: () => 0 } })
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'p6d', total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})
  const text = fake.calls.find((entry) => /P6/.test(String(entry.label))).prompt
    .map((block) => block.text ?? '').join('')

  assert.equal(out.review.verify.ran, true)
  assert.match(text, /basis=exact/u, 'refBasis must survive the verdict -> finding fold')
  assert.match(text, /refDomain=user-feedback/u)
  assert.match(text, /家族说明=F1 的形状唯一指向 user-feedback/u)
  assert.doesNotMatch(text, /basis=\(未给出\)/u, 'reaching P6 as "(未给出)" is the t41 defect')
  // …and the fold is still a whitelist: the junk the verdict also carried is gone.
  assert.equal(text.includes('P4-规则原文-不该到 P6'), false)
})

test('renderVerifyPrompt and renderReviewPrompt are two different documents', () => {
  const pack = { id: 'x', title: 'X', prompt: { role: 'r', instruction: 'i' }, reviewPrompts: { review: () => ({ system: 'REVIEW' }), verify: () => ({ system: 'VERIFY', instructions: 'i' }) } }
  const context = { domain: 'x', pack, target: 't', orientation: 'precision-first', findings: [] }
  const review = renderReviewPrompt(pack, pack.reviewPrompts, { ...context, bundle: { paths: [] }, ruleText: '' })
  const verify = renderVerifyPrompt(pack, pack.reviewPrompts, context)
  assert.equal(review.source, 'reviewPrompts')
  assert.equal(verify.source, 'reviewPrompts.verify')
  assert.notEqual(review.text, verify.text)
  // A pack with no prompts falls back — and the source says so.
  assert.equal(renderVerifyPrompt({ id: 'v1', prompt: { role: 'r', instruction: 'i' } }, undefined, context).source, 'legacy-verify')
  // A throwing verify() must degrade to text, never to a pipeline failure.
  const broken = { id: 'b', reviewPrompts: { review: () => ({ system: 'R' }), verify: () => { throw new Error('boom') } } }
  const degraded = renderVerifyPrompt(broken, broken.reviewPrompts, context)
  assert.match(degraded.source, /threw/u)
  assert.match(degraded.error, /boom/u)
})

test('extractVerdicts reads the shapes a provider actually returns', () => {
  assert.deepEqual(extractVerdicts('```json\n{"verdicts":[{"id":"a","keep":true}]}\n```'), [{ id: 'a', keep: true }])
  assert.deepEqual(extractVerdicts('{"verdicts":[{"id":"b","keep":false}]}'), [{ id: 'b', keep: false }])
  assert.deepEqual(extractVerdicts('[{"id":"c","keep":true}]'), [{ id: 'c', keep: true }])
  assert.deepEqual(extractVerdicts('no json here'), [], 'unparseable text yields no verdicts, never a fake pass')
})

// ---------------------------------------------------------------------------
console.log('\n15. t46 — AN UNPARSEABLE P6 ANSWER IS NOT AN EMPTY ONE')
// ---------------------------------------------------------------------------

test('extractVerdictsDetailed separates "no verdicts" from "no parseable answer"', () => {
  // Parsed-but-empty: the reviewer honestly answered with an empty list.
  const empty = extractVerdictsDetailed('```json\n{"verdicts":[]}\n```')
  assert.equal(empty.parsed, true)
  assert.deepEqual(empty.verdicts, [])
  assert.equal(empty.shape, 'verdicts')

  // An empty array is also a parsed answer.
  assert.deepEqual(extractVerdictsDetailed('[]'), { verdicts: [], parsed: true, shape: 'array' })

  // Unparseable: prose, an empty string, and a JSON object with no verdicts at all.
  for (const text of ['抱歉，我无法给出结构化结论。', '', '{"summary":"我复核过了","ok":true}']) {
    const detailed = extractVerdictsDetailed(text)
    assert.equal(detailed.parsed, false, `${JSON.stringify(text)} must NOT count as a parsed answer`)
    assert.deepEqual(detailed.verdicts, [])
    assert.equal(detailed.shape, null)
  }

  // The old wrapper keeps its signature: `[]` for both, which is exactly why the
  // caller needs the detailed form.
  assert.deepEqual(extractVerdicts('抱歉，我无法给出结构化结论。'), [])
  assert.deepEqual(extractVerdicts('{"verdicts":[]}'), [])
})

/** Submit one anchored finding against a p6 domain whose P6 child answers `answer`. */
async function p6AnswerHarness(id, answer) {
  const files = p6Domain(`domains/${id}`, id)
  const fake = fakeSubagents({
    result: (request) => (/P6/.test(String(request.label))
      ? answer
      : { stopReason: 'completed', structured: { findings: [] }, output: [] }),
  })
  const ctx = createContext({ subagents: fake.service, systemPrompt: { section: () => 0 } })
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: id, total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})
  const p6Section = String(out.summary).slice(String(out.summary).indexOf('## P6 独立复核'))
  return { out, verify: out.review.verify, p6Section }
}

const HONEST_EMPTY = { stopReason: 'completed', structured: { verdicts: [] }, output: [] }
const UNPARSEABLE = { stopReason: 'completed', structured: null, output: [{ type: 'text', text: '抱歉，我无法给出结构化结论。' }] }

await testAsync('an unparseable P6 answer is machine-distinguishable from an honest empty verdict list', async () => {
  const honest = await p6AnswerHarness('p6e', HONEST_EMPTY)
  const unparsed = await p6AnswerHarness('p6f', UNPARSEABLE)

  // Both really ran — "did not run" must stay a third, different state.
  assert.equal(honest.verify.ran, true)
  assert.equal(unparsed.verify.ran, true, 'a child DID run and the budget WAS spent: ran stays true')
  assert.equal(unparsed.verify.rounds, 1)
  assert.equal(unparsed.verify.mode, 'subagents')

  // The honest empty answer is a success with zero verdicts.
  assert.equal(honest.verify.ok, true)
  assert.equal(honest.verify.code, REASONER_CODES.OK)
  assert.deepEqual(honest.verify.verdicts, [])
  assert.deepEqual(honest.verify.errors, [])
  assert.match(honest.verify.reason, /0 verdict\(s\)/u)

  // The unparseable answer is a FAILED stage — not a clean pass with zero verdicts.
  assert.equal(unparsed.verify.ok, false, 'ok must go false: the stage did not succeed')
  assert.equal(unparsed.verify.code, REASONER_CODES.E_VERDICT_UNPARSED)
  assert.equal(unparsed.verify.code, 'E_VERDICT_UNPARSED')
  assert.equal(unparsed.verify.errors.length, 1, 'the parse failure is an error entry')
  assert.equal(unparsed.verify.errors[0].code, REASONER_CODES.E_VERDICT_UNPARSED)
  assert.match(unparsed.verify.errors[0].detail, /no verdict list survived parsing/u)
  assert.match(unparsed.verify.reason, /could not be parsed/u)
  assert.match(unparsed.verify.reason, /never as "nothing was rejected"/u)

  // …and no verdict is invented in either direction: no fabricated keep, no reject.
  assert.deepEqual(unparsed.verify.verdicts, [], 'an unparseable answer yields no verdicts, not a verdict')

  // The three fields differ verbatim — this is the assertion the repair must fail.
  assert.notEqual(unparsed.verify.code, honest.verify.code, 'code must differ verbatim')
  assert.notEqual(unparsed.verify.ok, honest.verify.ok, 'ok must differ verbatim')
  assert.notEqual(unparsed.verify.reason, honest.verify.reason, 'reason must differ verbatim')

  // The RENDERED report differs too, and the difference is legible to a human:
  // "no verdicts were produced" must never be printed for an unparseable answer.
  assert.notEqual(unparsed.p6Section, honest.p6Section, 'the rendered P6 sections must differ verbatim')
  assert.match(honest.p6Section, /裁决 0 条/u)
  assert.doesNotMatch(unparsed.p6Section, /裁决 0 条/u,
    'an unparseable answer must NOT be rendered as "裁决 0 条" — that is the t44 defect')
  assert.match(unparsed.p6Section, /无法解析/u)
  assert.match(unparsed.p6Section, /不是\*\*「没有要推翻的」/u)

  // P6 still does not gate admission: same finding set in, same keep/drop out.
  assert.deepEqual(
    unparsed.out.findings.map((f) => f.id),
    honest.out.findings.map((f) => f.id),
    'P6 does not decide admissibility, so the kept set must be identical',
  )
  assert.equal(unparsed.out.unanchored, honest.out.unanchored)
})

await testAsync('a prose answer that still contains a verdict block is parsed, not treated as a failure', async () => {
  // The discrimination is "could a verdict list be recovered", not "did it come
  // back as structured output". A chatty answer with a fenced block is fine.
  const rescued = await p6AnswerHarness('p6g', {
    stopReason: 'completed',
    structured: null,
    output: [{ type: 'text', text: '我逐条看过了：\n```json\n{"verdicts":[{"id":"f1","keep":true,"reason":"证据成立"}]}\n```\n以上。' }],
  })
  assert.equal(rescued.verify.ok, true)
  assert.equal(rescued.verify.code, REASONER_CODES.OK)
  assert.equal(rescued.verify.ran, true)
  assert.deepEqual(rescued.verify.verdicts, [{ id: 'f1', keep: true, reason: '证据成立' }])
  assert.deepEqual(rescued.verify.errors, [])
  assert.match(rescued.p6Section, /裁决 1 条/u)
})

await testAsync('without a reasoning service the unparseable path is unreachable, and that state stays distinct', async () => {
  // The three states are pairwise different: E_NO_REASONER (never ran),
  // E_VERDICT_UNPARSED (ran, answer unusable), OK (ran, answer usable).
  const files = p6Domain('domains/p6h', 'p6h')
  const bare = createContext({ systemPrompt: { section: () => 0 } })
  apply(bare, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })
  const out = await bare.__tools.get('adjudication_submit').execute({
    domain: 'p6h', total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})
  const verify = out.review.verify
  assert.equal(verify.ran, false)
  assert.equal(verify.code, REASONER_CODES.E_NO_REASONER)
  assert.notEqual(verify.code, REASONER_CODES.E_VERDICT_UNPARSED)
  const section = String(out.summary).slice(String(out.summary).indexOf('## P6 独立复核'))
  assert.match(section, /未执行/u)
  assert.doesNotMatch(section, /无法解析/u)
})


// ---------------------------------------------------------------------------
console.log('\n16. t49 — THE ANCHOR TIER VOCABULARY AGREES WITH THE PRODUCERS, BOTH WAYS')
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const SHIPPED_DOMAIN_ROOT = join(PACKAGE_ROOT, 'domains')

/**
 * The `tier` values a producer file can RETURN, comments stripped.
 *
 * Source-level on purpose. A tier lives inside a verifier closure, so the only
 * mechanical question answerable without executing an arbitrary domain's
 * fixtures is "does this producer name the tier as a return value". The check
 * FAILS CLOSED: a producer that built the tier string dynamically would be
 * reported as producing nothing, and a human then either makes it literal or
 * drops the tier — the safe direction.
 */
function emittedTiers(source) {
  const code = String(source)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gmu, '')
  const tiers = new Set()
  for (const match of code.matchAll(/\btier:\s*['"]([a-z][a-z-]*)['"]/gu)) tiers.add(match[1])
  return tiers
}

/** Every file that can hand a verdict to the engine: the ladder, the engine's own P5 paths, and the shipped verifiers. */
function producerFiles() {
  const files = [join(PACKAGE_ROOT, 'lib/engine.js'), join(PACKAGE_ROOT, 'index.js')]
  if (existsSync(SHIPPED_DOMAIN_ROOT)) {
    for (const entry of readdirSync(SHIPPED_DOMAIN_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const anchorFile = join(SHIPPED_DOMAIN_ROOT, entry.name, 'anchor.js')
      if (existsSync(anchorFile)) files.push(anchorFile)
    }
  }
  return files
}

/** tier -> the producer files that name it as a return value. */
function producerSourceTiers() {
  const found = new Map()
  for (const file of producerFiles()) {
    for (const tier of emittedTiers(readFileSync(file, 'utf8'))) {
      const where = found.get(tier) ?? []
      where.push(relative(PACKAGE_ROOT, file).split('\\').join('/'))
      found.set(tier, where)
    }
  }
  return found
}

/**
 * The producers that can be EXECUTED here, split by whether their verdict can
 * escape into a finding:
 *   • `ladder`  — `resolveAnchor`, whose result IS the verdict (`via: 'engine-resolveAnchor'`);
 *   • `helper`  — `anchorInDocument`, whose hit marker `sliding-window` is re-tiered
 *                 by the ladder before it can escape (pinned below).
 */
function runtimeTiers() {
  const ladder = new Set()
  const helper = new Set()
  const add = (set, result) => {
    if (typeof result?.tier === 'string') set.add(result.tier)
  }
  add(ladder, resolveAnchor('alpha', [], undefined))                                          // no-documents
  add(ladder, resolveAnchor('alpha', [{ path: 'a.md', content: 'alpha' }], 'a.md'))            // declared-document
  add(ladder, resolveAnchor('beta', [{ path: 'a.md', content: 'alpha' }, { path: 'c.md', content: 'beta' }], 'a.md'))
  add(ladder, resolveAnchor('dup', [{ path: 'a.md', content: 'dup' }, { path: 'b.md', content: 'dup' }], 'z.md'))
  add(ladder, resolveAnchor('nowhere', [{ path: 'a.md', content: 'alpha' }], 'a.md'))
  add(helper, anchorInDocument('', 'alpha'))                                                   // empty-excerpt
  add(helper, anchorInDocument('alpha', 'alpha'))                                              // sliding-window
  return { ladder, helper, all: new Set([...ladder, ...helper]) }
}

test('declared → produced: every declared tier is returned by a real producer', () => {
  // Why this direction exists: `domain-locator` was DECLARED in ANCHOR_TIERS,
  // listed in TRUSTED_ANCHOR_TIERS, and returned by NOTHING — every shipped
  // verifier (including the ID/graph families it was added for) reports
  // `declared-locator`, and the ladder cannot return it either. A declared tier
  // with no producer is a promise the contract cannot keep, and only a
  // mechanical check can tell "supported" from "written down".
  const runtime = runtimeTiers()
  const source = producerSourceTiers()
  const missing = Object.keys(ANCHOR_TIERS).filter((tier) => !runtime.all.has(tier) && !source.has(tier))
  assert.deepEqual(missing, [],
    `declared tier(s) ${JSON.stringify(missing)} have NO producer: neither the executes-here probes nor any producer file (${producerFiles().map((f) => relative(PACKAGE_ROOT, f).split('\\').join('/')).join(', ')}) returns them. Either a real producer must return the tier, or it must not be declared.`)

  // …and the measurement above is not vacuous: both halves really have content.
  assert.ok(runtime.ladder.has('declared-document'), 'the ladder probe must actually reach the engine tier-1 verdict')
  assert.ok(runtime.helper.has('empty-excerpt'), 'the helper probe must actually run anchorInDocument')
  assert.ok(source.has('declared-locator'), 'the shipped verifiers must be readable for this test to mean anything')
  assert.ok(source.size >= 5, `expected the producer files to name several tiers, saw ${source.size}`)
})

test('produced → declared: every tier a real producer returns is declared', () => {
  // The mirror of the direction above, and the gap the captain named: `lib/engine.js`
  // returned `declared-document` and `anchorInDocument` returned `sliding-window`
  // while NEITHER was in ANCHOR_TIERS — the ladder path never goes through
  // `validateAnchorVerdict`, so nothing complained. `index.js` had the same hole
  // with `no-excerpt` and `invalid-verdict`. An undeclared tier is a verdict the
  // vocabulary cannot describe: a caller cannot even DOWNGRADE it by name.
  const runtime = runtimeTiers()
  const source = producerSourceTiers()
  const named = new Set([...runtime.all, ...source.keys()])
  const undeclared = [...named].filter((tier) => !Object.hasOwn(ANCHOR_TIERS, tier)).sort()
  assert.deepEqual(undeclared, [],
    `tier(s) ${JSON.stringify(undeclared)} are RETURNED by a real producer but not declared in ANCHOR_TIERS — declare them (and say whether they are trusted) or stop returning them.`)

  // The two halves of the measurement are both real.
  assert.ok(source.has('no-excerpt'), 'index.js must be read: its engine-P5 verdicts are part of the vocabulary')
  assert.ok(source.has('invalid-verdict'), 'index.js downgrades a broken verdict by name — that name must be declared too')

  // `sliding-window` is declared because a real producer names it, but it must
  // never ESCAPE as a verdict: the ladder re-tiers every hit. This pin is what
  // keeps the declaration honest instead of turning it into a licence.
  assert.equal(runtime.helper.has('sliding-window'), true, 'anchorInDocument really does name it')
  assert.equal(runtime.ladder.has('sliding-window'), false,
    'resolveAnchor must re-tier a hit as declared-document/relocated-unique — a raw sliding-window must never reach a finding')
})

test('an engine verdict that breaks the contract is downgraded, never handed over', () => {
  // The enforcement half of the direction above: declaring the vocabulary is not
  // enough if the engine can still EMIT something outside it. `validatedEngineVerdict`
  // is applied inside `resolveAnchor` and to the `no-excerpt` outcome, and it is
  // exported so this rule can be driven directly instead of only by breaking the
  // engine — a rule nobody can test is the defect this team keeps finding.
  const good = { status: 'anchored', tier: 'declared-document', path: 'a.md', start: 1, end: 1 }
  assert.equal(validatedEngineVerdict(good), good, 'a conforming verdict passes through UNTOUCHED')

  const ghost = validatedEngineVerdict({ status: 'anchored', tier: 'ghost-tier', path: 'a.md', start: 1, end: 1 })
  assert.equal(ghost.status, 'unanchored')
  assert.equal(ghost.tier, 'invalid-verdict')
  assert.equal(Object.hasOwn(ANCHOR_TIERS, ghost.tier), true, 'even the downgrade names a DECLARED tier')
  assert.equal(ghost.path, null)
  assert.match(ghost.detail, /untrusted tier/u)

  // DECLARED is not TRUSTED: the helper marker is nameable (direction 2 demands
  // it) and still cannot be an anchored verdict.
  const marker = validatedEngineVerdict({ status: 'anchored', tier: 'sliding-window', path: 'a.md', start: 1, end: 1 })
  assert.equal(marker.tier, 'invalid-verdict', 'a declared-but-untrusted tier must not anchor')

  // And the verdicts the engine really produces are clean by construction.
  for (const verdict of [
    resolveAnchor('alpha', [{ path: 'a.md', content: 'alpha' }], 'a.md'),
    resolveAnchor('alpha', [], undefined),
    resolveAnchor('nowhere', [{ path: 'a.md', content: 'alpha' }], 'a.md'),
    { status: 'unanchored', tier: 'no-excerpt', path: null, start: null, end: null },
  ]) {
    assert.deepEqual(validateAnchorVerdict(verdict), [], `the engine must not produce ${JSON.stringify(verdict)}`)
  }
})


// ---------------------------------------------------------------------------
console.log('\n17. t49 — THE "P6 IS NOT P4" PROPERTY IS MECHANICALLY ENFORCED')
// ---------------------------------------------------------------------------

/**
 * A domain whose two prompt roles are DIFFERENT functions that render the SAME
 * text. `review` returns a `system` and no `rules`; `verify` returns that same
 * `system` with an empty `instructions` — both renderers drop the empty part, so
 * both documents come out as `system` alone.
 *
 * This shape is the reason the gate has TWO layers: no load-time check can see
 * it (the two functions are distinct objects with distinct source), and no
 * run-time check can see the other witness (below).
 */
function p6SameTextFiles(id, system = '同一段提示词') {
  const files = p6Domain(`domains/${id}`, id)
  files[`domains/${id}/prompts.js`] = {
    default: {
      __contract: CONTRACT_VERSION,
      review: () => ({ system }),
      verify: () => ({ system, instructions: '' }),
    },
  }
  return files
}

await testAsync('a P6 document that renders byte-identical to P4 is REFUSED, not run', async () => {
  const files = p6SameTextFiles('p6i')
  const fake = fakeSubagents({
    result: () => ({ stopReason: 'completed', structured: { verdicts: [{ id: 'f1', keep: false, reason: '不该被问到' }] }, output: [] }),
  })
  const ctx = createContext({ subagents: fake.service, systemPrompt: { section: () => 0 } })
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'p6i', total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})
  const verify = out.review.verify

  // The stage is FAILED and NAMED — a fourth state, not a clean pass.
  assert.equal(verify.code, REASONER_CODES.E_P6_NOT_INDEPENDENT)
  assert.equal(verify.code, 'E_P6_NOT_INDEPENDENT')
  assert.equal(verify.ok, false, 'a re-check whose text is P4 text did not succeed')
  assert.equal(verify.ran, false, 'nothing was started and no budget was spent — ran must stay false')
  assert.equal(verify.rounds, 0)
  assert.deepEqual(verify.verdicts, [], 'a refused re-check invents no verdict in either direction')
  assert.equal(verify.errors.length, 1)
  assert.equal(verify.errors[0].code, REASONER_CODES.E_P6_NOT_INDEPENDENT)
  assert.match(verify.errors[0].detail, /same \d+ characters/u)
  assert.match(verify.errors[0].detail, /P6 source=reviewPrompts\.verify/u)
  assert.match(verify.reason, /byte-identical/u)
  assert.match(verify.reason, /NOT started/u)

  // The refusal happens BEFORE the child, so it cannot be a post-hoc note.
  assert.equal(fake.calls.filter((call) => /P6/.test(String(call.label))).length, 0,
    'no P6 child may be started when the prompt is refused')

  // And the report says so in words that cannot be confused with the other states.
  const section = String(out.summary).slice(String(out.summary).indexOf('## P6 独立复核'))
  assert.match(section, /P6 未启动/u)
  assert.match(section, /逐字相同/u)
  assert.doesNotMatch(section, /未执行/u, 'this is not "the host has no model"')
  assert.doesNotMatch(section, /裁决 \d+ 条/u, 'a refused re-check must never be reported as a verdict count')
  assert.doesNotMatch(section, /无法解析/u, 'this is not the t46 state either')
})

await testAsync('…and the identical shape with a genuinely different P6 text DOES run', async () => {
  // The control: without this, "the gate fires" and "the gate always fires" look
  // the same. Same domain, same finding, one prompt changed.
  const files = p6Domain('domains/p6j', 'p6j')
  const fake = fakeSubagents({
    result: (request) => (/P6/.test(String(request.label))
      ? { stopReason: 'completed', structured: { verdicts: [{ id: 'f1', keep: false, reason: '复核判不通过' }] }, output: [] }
      : { stopReason: 'completed', structured: { findings: [] }, output: [] }),
  })
  const ctx = createContext({ subagents: fake.service, systemPrompt: { section: () => 0 } })
  apply(ctx, { domainIo: createMemoryIo(files), loadModule: stubLoader(files) })

  const out = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'p6j', total: 1, documents: P6_DOCUMENTS, findings: [P6_FINDING],
  }, {})
  const verify = out.review.verify
  assert.equal(verify.code, REASONER_CODES.OK)
  assert.equal(verify.ran, true)
  assert.equal(verify.rounds, 1)
  assert.equal(verify.verdicts.length, 1)
  assert.equal(fake.calls.filter((call) => /P6/.test(String(call.label))).length, 1)
})

await testAsync('a domain that hands ONE function to both prompt roles is rejected at load time', async () => {
  // Layer 1, and the reason it is not redundant with layer 2: the shared
  // function returns BOTH a `rules` and an `instructions` string, so the two
  // renderers would produce DIFFERENT texts (`system\n\nrules` vs
  // `system\n\ninstructions`) and the render-time gate would stay silent. Only
  // identity catches this one, and it catches it before anything runs.
  const files = domainFiles('domains/alias', 'alias')
  const shared = () => ({ system: '同一段话', rules: 'P4 规则正文', instructions: 'P6 说明' })
  files['domains/alias/prompts.js'] = {
    default: { __contract: CONTRACT_VERSION, review: shared, verify: shared },
  }
  const result = await loadDomains(createMemoryIo(files), { loadModule: stubLoader(files) })

  assert.equal(result.packs.length, 0, 'the pack must not be registered')
  assert.equal(result.problems.length, 1)
  assert.ok(
    result.problems[0].problems.some((problem) => /must be two different functions/u.test(problem)),
    result.problems[0].problems.join('; '),
  )
  assert.ok(
    result.problems[0].problems.some((problem) => /INDEPENDENT/u.test(problem)),
    'the reason must say WHY, not just that it is wrong',
  )
})


// ---------------------------------------------------------------------------
console.log('\n18. t52 — THE PROMPT SECTION DESCRIBES THE SURFACE IT IS ACTUALLY ON')
// ---------------------------------------------------------------------------

/**
 * Capture the section the plugin registers, so its `text()` can be rendered on
 * demand — exactly what a host does when it builds a system prompt.
 */
function promptRecorder() {
  const captured = []
  return {
    captured,
    service: { systemPrompt: { section: (spec) => { captured.push(spec); return () => {} } } },
  }
}

/** The recall-first line, and the ids in it, as a prompt reader sees them. */
function recallLineOf(text) {
  return text.split('\n').find((line) => line.startsWith('recall-first')) ?? ''
}
function idsInRecallLine(text) {
  const line = recallLineOf(text)
  const at = line.indexOf('：')
  if (at < 0) return []
  return line.slice(at + 1).replace(/（[\s\S]*$/u, '').split(', ').map((id) => id.trim()).filter(Boolean)
}
/** What the USER-VISIBLE authority (`adjudication_domains`) reports. */
const recallOfListing = (listing) => listing.domains
  .filter((pack) => pack.lossOrientation === 'recall-first')
  .map((pack) => pack.id)

// --- (1) the built-in fallback surface ------------------------------------
// Before any tool call triggers directory discovery, the registry holds the
// nineteen built-in records. The line must say that is what it is describing,
// and its ids must be the registry's — not `RECALL_FIRST_DOMAINS` copied in.
await testAsync('on the built-in surface the line says so, and its ids are the built-in set', async () => {
  const recorder = promptRecorder()
  const ctx = createContext(recorder.service)
  apply(ctx, { ...EMPTY_DOMAIN_IO })

  const text = recorder.captured.map((spec) => spec.text()).join('\n')
  assert.match(recallLineOf(text), /内置回退表面/u, 'a pre-discovery snapshot must not read as a permanent fact')

  const ids = idsInRecallLine(text)
  assert.deepEqual(ids, RECALL_FIRST_DOMAINS, 'the built-in surface is exactly what RECALL_FIRST_DOMAINS names')
  assert.equal(ids.includes('algo-model'), false, 'the built-in record for algo-model is precision-first')

  // The tool is the authority the model is pointed at; it must agree.
  const listing = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.deepEqual(ids, recallOfListing(listing), 'the prompt line and adjudication_domains must not disagree')
})

// --- (2) the v2 surface, after discovery ----------------------------------
// THE LOAD-BEARING ONE: with the real `domains/` root, discovery replaces
// built-in records by id, and `algo-model` becomes recall-first. A line fed by
// the constant would keep saying nine, forever, with no qualifier to warn
// anyone. This is the assertion that makes that impossible.
await testAsync('after discovery the line tracks the v2 packs, and stops claiming the built-in surface', async () => {
  const recorder = promptRecorder()
  const ctx = createContext(recorder.service)
  apply(ctx, {
    domainIo: await createNodeIo({ root: PACKAGE_ROOT }),
    domainRoot: 'domains',
  })

  const before = recorder.captured.map((spec) => spec.text()).join('\n')
  assert.match(recallLineOf(before), /内置回退表面/u, 'discovery has not run yet — and the line must admit it')
  assert.deepEqual(idsInRecallLine(before), RECALL_FIRST_DOMAINS)

  const listing = await ctx.__tools.get('adjudication_domains').execute({}, {})
  const authoritative = recallOfListing(listing)
  const after = recorder.captured.map((spec) => spec.text()).join('\n')
  const ids = idsInRecallLine(after)

  assert.equal(authoritative.includes('algo-model'), true, 'the v2 pack for algo-model is recall-first')
  assert.deepEqual(ids, authoritative, 'the line must follow the packs that are in force')
  assert.equal(ids.length, RECALL_FIRST_DOMAINS.length + 1)
  assert.equal(ids.includes('algo-model'), true)
  assert.notDeepEqual(ids, RECALL_FIRST_DOMAINS, 'the text must NOT be the built-in constant')
  assert.doesNotMatch(recallLineOf(after), /内置回退表面/u, 'the qualifier must go away once it is no longer true')
})


// ---------------------------------------------------------------------------
// request-router — ONE REQUEST, SEVERAL DOMAINS, AND A REASON PER HIT
// ---------------------------------------------------------------------------
// `search` used to be a single `haystack.includes(query)` test. That answered
// `"算子"` and `"operator-design"` correctly and returned ZERO for the shape a
// user actually types: one sentence that touches several areas and names none
// of them. The empty result carried no signal at all — "no match" and "no such
// domain" look exactly alike — and it failed hardest on the case that needs
// routing most. These assertions run on the REAL nineteen packs.
async function realRegistry() {
  const loaded = await loadDomains(await createNodeIo({ root: PACKAGE_ROOT }), { root: 'domains' })
  const registry = createRegistry({ strict: false })
  registry.registerAll(loaded.packs)
  return registry
}

await testAsync('a whole sentence routes to every domain it touches, best first, with reasons', async () => {
  const registry = await realRegistry()
  const sentence = '算子的数值容差改了，前端渲染也跟着动了，测试覆盖没补，文档也没更新'
  const ranked = registry.rank(sentence)
  const top = ranked.map((hit) => hit.pack.id)

  assert.equal(top[0], 'operator-design', '「数值容差」 is operator-design business')
  for (const expected of ['tech-test', 'frontend-engineering', 'tech-doc']) {
    assert.equal(top.includes(expected), true, `the same sentence touches ${expected}`)
  }
  assert.equal(ranked.length >= 4, true, 'a four-area sentence must not collapse to one domain, nor to none')
  assert.equal(
    ranked.every((hit) => hit.reasons.length > 0),
    true,
    'every hit carries WHY it was selected — an unexplained shortlist is not routable information',
  )
  assert.deepEqual(
    [...ranked].sort((a, b) => b.score - a.score).map((hit) => hit.pack.id),
    top,
    'hits come back ranked best-first',
  )
})

await testAsync('routing keeps the old answers and still never confuses "nothing" with "everything"', async () => {
  const registry = await realRegistry()

  assert.deepEqual(registry.search('operator-design').slice(0, 1).map((pack) => pack.id), ['operator-design'])
  assert.deepEqual(registry.search('算子').map((pack) => pack.id), ['operator-design'])
  assert.equal(registry.search('').length, 19, 'an empty query means "all of them", not "none of them"')
  assert.equal(registry.rank('').every((hit) => hit.score === 0), true, 'with no query nothing is ranked above anything')

  // A request that names a REGION rather than a domain still lands somewhere
  // defensible, and the shape survives: ranked, with reasons.
  const ranked = registry.rank('这几条客户反馈和我们的决策对不上')
  assert.equal(ranked[0].pack.id, 'user-feedback')
  assert.equal(ranked[0].reasons.length > 0, true)
})

console.log(`\n${'='.repeat(54)}`)
console.log(`${passes} passed, ${failures} failed`)

// ---------------------------------------------------------------------------
// t55 — THE EXPECTED NUMBERS IN THE DOCS ARE COMPARED, NOT REMEMBERED
// ---------------------------------------------------------------------------
// Three places state how many assertions this file has. They were all stale at
// once (still claiming 93 after the suite reached 95) because each was a copy
// maintained by hand, and nothing in `npm test` could notice: the commands still
// ran, they just ran a different number than the documents promised. This block
// is the missing mechanism — it reads the number back out of the documents and
// compares it with what this run actually produced.
//
// Deliberately NOT a `test()`: a check that changed the number it is checking
// could never agree with itself.
const DOC_NUMBER_SITES = [
  {
    file: 'README.md',
    label: 'the assertion table row',
    pattern: /^\| `lib\/kernel-test\.mjs` \| (\d+) \|/gmu,
  },
  {
    file: 'docs/domain-contract-v2-runtime.md',
    label: 'the file map ("现 N 条")',
    pattern: /现 \*\*(\d+) 条\*\*/gu,
  },
  {
    file: 'docs/domain-contract-v2-runtime.md',
    label: 'the command listing ("-> N passed, 0 failed")',
    pattern: /node lib\/kernel-test\.mjs\s*-> (\d+) passed, 0 failed/gu,
  },
]

if (failures > 0) {
  console.log('\ndoc drift check: skipped — assertions failed above, fix those first')
} else {
  const drift = []
  for (const site of DOC_NUMBER_SITES) {
    let text
    try {
      text = readFileSync(join(PACKAGE_ROOT, site.file), 'utf8')
    } catch (error) {
      drift.push(`${site.file} (${site.label}): cannot be read — ${error?.message ?? error}`)
      continue
    }
    const found = [...String(text).matchAll(site.pattern)].map((match) => match[1])
    if (found.length === 0) {
      drift.push(`${site.file} (${site.label}): the expected number is GONE — the pattern matched nothing`)
      continue
    }
    for (const value of found) {
      if (Number(value) !== passes) {
        drift.push(`${site.file} (${site.label}): says ${value}, this run produced ${passes}`)
      }
    }
  }
  if (drift.length > 0) {
    console.log('\nMISMATCH — the documents state a number this suite does not produce:')
    for (const line of drift) console.log(`  - ${line}`)
    console.log(`  this run: ${passes} passed. Fix the documents (or fix what reads them) before shipping.`)
    process.exitCode = 1
  } else {
    console.log(`doc drift check: ${DOC_NUMBER_SITES.length} places state this suite's ${passes} assertions, all agree`)
  }
}

if (failures > 0) process.exitCode = 1
