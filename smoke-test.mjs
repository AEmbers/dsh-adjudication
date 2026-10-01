/**
 * Smoke test — no test framework, no dependencies. `node smoke-test.mjs`.
 *
 * It drives the plugin through a mock Cordis context that implements exactly the
 * surface `apply()` uses (`effect`, `tools.register`, `inject`, `provide`,
 * `set`, `logger`). If this passes, the plugin mounts; if the assertions pass,
 * the on-demand tool lifecycle really works — which is the whole design claim.
 */

import assert from 'node:assert/strict'
import { apply, name, inject, DEFAULT_OPTIONS } from './index.js'
import {
  gate, bundle, resolveAnchor, selectRules, renderRules,
  runCritiquePanel, coverage, normalizeLine, matchConsecutive,
} from './lib/engine.js'
import { BUILTIN_DOMAINS, RECALL_FIRST_DOMAINS } from './lib/domains.js'
import { validateDomain } from './lib/registry.js'

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

/** Minimal stand-in for the harness context. */
function createMockContext() {
  const tools = new Map()
  const effects = []
  const injected = []
  const services = new Map()
  let injectedCallbacks = 0

  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },

    effect(callback, label) {
      const entry = { label, dispose: undefined, undone: false }
      // Faithfully mimic the harness: a generator yields one disposer per
      // registration; a plain function returns a single disposer.
      const collect = (disposer) => {
        if (typeof disposer === 'function') {
          entry.dispose = disposer
        }
      }
      if (typeof callback === 'function' && callback.constructor?.name === 'GeneratorFunction') {
        const iterator = callback()
        const produced = []
        let step = iterator.next()
        while (step.done !== true) {
          if (typeof step.value === 'function') produced.push(step.value)
          step = iterator.next()
        }
        entry.dispose = () => {
          for (const dispose of produced.reverse()) dispose()
        }
      } else {
        collect(callback())
      }
      effects.push(entry)
      const dispose = () => {
        if (entry.undone) return
        entry.undone = true
        entry.dispose?.()
      }
      entry.undone = false
      return dispose
    },

    tools: {
      register(definition) {
        if (tools.has(definition.name)) {
          throw new Error(`tool "${definition.name}" is already registered`)
        }
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (toolName) => tools.get(toolName),
      names: () => [...tools.keys()],
    },

    inject(services_, callback) {
      injected.push(services_)
      injectedCallbacks += 1
      // Provide the systemPrompt service so the optional section path runs.
      if (services_.includes('systemPrompt')) {
        callback({
          effect: (fn, label) => ctx.effect(fn, label),
          systemPrompt: {
            section: (spec) => {
              ctx.__promptSection = spec
              return () => { delete ctx.__promptSection }
            },
          },
        })
      }
    },

    provide(key, value) { services.set(key, value) },
    set(key, value) { services.set(key, value) },
    get(key) { return services.get(key) },

    __tools: tools,
    __effects: effects,
    __services: services,
    __injected: injected,
    __injectedCallbacks: injectedCallbacks,
  }
  return ctx
}

console.log(`\ndsh-adjudication smoke test\n${'='.repeat(50)}\n`)

// ---------------------------------------------------------------------------
console.log('module shape')
// ---------------------------------------------------------------------------

test('exports a cordis plugin identity', () => {
  assert.equal(name, 'adjudication')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('every built-in domain pack validates', () => {
  assert.equal(BUILTIN_DOMAINS.length, 19)
  for (const pack of BUILTIN_DOMAINS) {
    assert.deepEqual(validateDomain(pack), [], `domain ${pack.id}`)
  }
})

test('domain ids are unique', () => {
  assert.equal(new Set(BUILTIN_DOMAINS.map((pack) => pack.id)).size, BUILTIN_DOMAINS.length)
})

test('the recall-first set is non-empty and every member declares it', () => {
  assert.ok(RECALL_FIRST_DOMAINS.length >= 8, `expected >= 8, got ${RECALL_FIRST_DOMAINS.length}`)
  for (const id of RECALL_FIRST_DOMAINS) {
    const pack = BUILTIN_DOMAINS.find((candidate) => candidate.id === id)
    assert.equal(pack.lossOrientation, 'recall-first')
  }
})

// ---------------------------------------------------------------------------
console.log('\nmount and teardown')
// ---------------------------------------------------------------------------

test('mounts and registers exactly the six core tools', () => {
  const ctx = createMockContext()
  apply(ctx, { domains: 'all' })
  assert.deepEqual([...ctx.__tools.keys()].sort(), [
    'adjudication_activate', 'adjudication_anchor', 'adjudication_deactivate',
    'adjudication_domains', 'adjudication_plan', 'adjudication_submit',
  ])
})

test('installs an optional system-prompt section', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  assert.ok(ctx.__injected.some((names) => names.includes('systemPrompt')))
  assert.ok(ctx.__promptSection, 'expected a prompt section')
  const rendered = ctx.__promptSection.text()
  assert.match(rendered, /adjudication_activate/)
  // The section must stay small. Enumerating all nineteen domains would defeat
  // the on-demand design it is advertising, so bound it and count how many
  // domain ids it actually names.
  assert.ok(rendered.length < 1400, `prompt section is ${rendered.length} chars`)
  const named = BUILTIN_DOMAINS.filter((pack) => rendered.includes(pack.id)).length
  assert.ok(named < BUILTIN_DOMAINS.length / 2, `section names ${named} of ${BUILTIN_DOMAINS.length} domains`)
})

test('prompt section can be turned off', () => {
  const ctx = createMockContext()
  apply(ctx, { promptSection: false })
  assert.equal(ctx.__promptSection, undefined)
})

test('honours a domain subset', () => {
  const ctx = createMockContext()
  apply(ctx, { domains: ['code-review', 'ux-review'] })
  assert.equal(ctx.get('adjudication').listDomains().length, 2)
})

test('the whole plugin unmounts cleanly', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  assert.ok(ctx.__tools.size >= 6)
  for (const entry of ctx.__effects) {
    if (!entry.undone) entry.dispose?.()
  }
  assert.equal(ctx.__tools.size, 0, 'every tool must be withdrawn on unload')
})

// ---------------------------------------------------------------------------
console.log('\non-demand tool lifecycle (the design claim)')
// ---------------------------------------------------------------------------

test('domain tools are absent until activated', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  assert.equal(ctx.__tools.has('adjudicate_code_review'), false)
  assert.equal(ctx.__tools.has('adjudication_activate'), true)
})

test('activate registers the domain toolset', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const result = await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.tools.sort(), ['adjudicate_code_review', 'adjudicate_code_review_plan', 'adjudicate_code_review_rules'])
  for (const toolName of result.tools) assert.ok(ctx.__tools.has(toolName), `${toolName} must be registered`)
})

test('depth=entry registers only the entry tool', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const result = await ctx.__tools.get('adjudication_activate').execute({ domain: 'ux-review', depth: 'entry' }, {})
  assert.deepEqual(result.tools, ['adjudicate_ux_review'])
})

test('activating twice is idempotent, not a duplicate-name crash', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const activate = ctx.__tools.get('adjudication_activate')
  await activate.execute({ domain: 'code-review' }, {})
  const second = await activate.execute({ domain: 'code-review' }, {})
  assert.equal(second.alreadyActive, true)
  assert.equal(second.ok, true)
})

test('deactivate withdraws exactly that domain', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'ux-review' }, {})
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'code-review' }, {})
  assert.equal(ctx.__tools.has('adjudicate_code_review'), false)
  assert.equal(ctx.__tools.has('adjudicate_ux_review'), true)
  assert.equal(ctx.__tools.has('adjudication_domains'), true, 'core tools survive')
})

test('activating an unknown domain fails loudly, not silently', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const result = await ctx.__tools.get('adjudication_activate').execute({ domain: 'nope' }, {})
  assert.equal(result.ok, false)
  assert.match(result.summary, /unknown domain/)
})

test('a downstream pack registers through the facade', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const facade = ctx.get('adjudication')
  const dispose = facade.registerDomain({
    id: 'custom-domain',
    title: '自定义领域',
    category: 'A',
    lossOrientation: 'precision-first',
    anchor: { kind: 'custom' },
  })
  assert.equal(facade.listDomains().length, 20)
  dispose()
  assert.equal(facade.listDomains().length, 19)
})

// ---------------------------------------------------------------------------
console.log('\nP1 gate')
// ---------------------------------------------------------------------------

test('the gate is ordered and records why each candidate was dropped', () => {
  const result = gate([
    { path: 'src/app.ts', bytes: 100 },
    { path: 'src/secret/.env' },
    { path: 'node_modules/lib/index.js' },
    { path: 'logo.png' },
    { path: 'src/huge.ts', bytes: 99_999_999 },
  ], { extensions: ['.ts', '.js'] })
  assert.deepEqual(result.selected.map((item) => item.path), ['src/app.ts'])
  const reasons = Object.fromEntries(result.excluded.map((item) => [item.path, item.predicate]))
  assert.equal(reasons['src/secret/.env'], 'secret')
  assert.equal(reasons['node_modules/lib/index.js'], 'default-path')
  assert.equal(reasons['logo.png'], 'extension')
  assert.equal(reasons['src/huge.ts'], 'too-large')
  assert.deepEqual(result.ordered, ['binary', 'secret', 'deleted', 'user-exclude', 'user-include', 'extension', 'default-path', 'too-large'])
})

test('the gate order puts secrets ahead of a user include rule', () => {
  const result = gate([{ path: '.ssh/id_rsa' }], { include: ['**'] })
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded[0].predicate, 'secret')
})

test('an explicit include rule short-circuits the convenience exclusions', () => {
  const result = gate([
    { path: 'vendor/lib/keep.ts' },
    { path: 'vendor/lib/other.ts' },
  ], { include: ['vendor/**'], extensions: ['.ts'] })
  assert.deepEqual(result.selected.map((item) => item.path), ['vendor/lib/keep.ts', 'vendor/lib/other.ts'])
  assert.equal(result.selected[0].forcedByInclude, true)
})

test('glob ** spans separators and * does not', () => {
  const result = gate([
    { path: 'a/b/c.ts' },
    { path: 'a/b/deep/c.ts' },
  ], { exclude: ['a/*/c.ts'] })
  assert.deepEqual(result.selected.map((item) => item.path), ['a/b/deep/c.ts'])
})

// ---------------------------------------------------------------------------
console.log('\nP2 bundling')
// ---------------------------------------------------------------------------

test('a single candidate short-circuits without a planning call', () => {
  const result = bundle([{ path: 'a.ts' }])
  assert.equal(result.strategy, 'short-circuit-single')
})

test('fewer than minFiles bundles as one unit', () => {
  const result = bundle([{ path: 'a.ts' }, { path: 'b.ts' }])
  assert.equal(result.strategy, 'short-circuit-small')
  assert.equal(result.bundles.length, 1)
})

test('a large group degrades to one bundle per entry instead of overflowing', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({ path: `src/f${index}.ts`, additions: 50, key: 'src' }))
  const result = bundle(entries)
  assert.ok(result.degraded)
  for (const item of result.bundles) assert.ok(item.entries.length <= 10)
  const total = result.bundles.reduce((sum, item) => sum + item.entries.length, 0)
  assert.equal(total, 25, 'degradation must not drop candidates')
})

// ---------------------------------------------------------------------------
console.log('\nP3 rule selection')
// ---------------------------------------------------------------------------

test('first matching rule wins, in declaration order', () => {
  const rules = [
    { name: 'specific', match: ['**/*.ts'], text: 'specific text' },
    { name: 'general', match: ['**/*'], text: 'general text' },
  ]
  const { injected } = selectRules(rules, ['a.ts'])
  assert.deepEqual(injected.map((rule) => rule.name), ['specific', 'general'])
})

test('a single matched rule renders unwrapped, for prompt-prefix stability', () => {
  const rendered = renderRules([{ name: 'one', text: 'BODY' }], ['a.ts'])
  assert.equal(rendered, 'BODY')
})

test('multiple matched rules render inside an attribute-bearing wrapper', () => {
  const rendered = renderRules([{ name: 'a', text: 'A' }, { name: 'b', text: 'B' }], ['x.ts', 'y.ts'])
  assert.equal(rendered, '<rules for="x.ts,y.ts">\nA\n\nB\n</rules>')
})

// ---------------------------------------------------------------------------
console.log('\nP5 anchor resolution')
// ---------------------------------------------------------------------------

test('normalisation strips diff markers and whitespace', () => {
  assert.equal(normalizeLine('+   const x = 1'), 'constx=1')
  assert.equal(normalizeLine('-  const x = 1'), 'constx=1')
})

test('consecutive matching is whitespace- and marker-insensitive', () => {
  const haystack = [' a', '+  b', 'c']
  assert.equal(matchConsecutive(haystack, ['a', 'b', 'c']), 0)
})

test('tier 1 anchors in the declared document', () => {
  // The excerpt is copied VERBATIM, punctuation included. Only indentation and
  // diff markers are forgiven, which is the documented contract.
  const result = resolveAnchor('const x = 1;', [{ path: 'a.ts', content: 'let y\nconst  x = 1;\n' }], 'a.ts')
  assert.equal(result.status, 'anchored')
  assert.equal(result.tier, 'declared-document')
  assert.equal(result.start, 2)
})

test('a paraphrased excerpt does NOT anchor — strictness is the safety property', () => {
  const result = resolveAnchor('const x = 1', [{ path: 'a.ts', content: 'const x = 1;' }], 'a.ts')
  assert.equal(result.status, 'unanchored')
})

test('tier 2 relocates only on a unique hit', () => {
  const docs = [
    { path: 'wrong.ts', content: 'nothing here' },
    { path: 'right.ts', content: 'alpha\nconst x = 1;\nbeta' },
  ]
  const result = resolveAnchor('const x = 1;', docs, 'wrong.ts')
  assert.equal(result.status, 'anchored')
  assert.equal(result.tier, 'relocated-unique')
  assert.equal(result.path, 'right.ts')
})

test('an ambiguous relocation REFUSES to guess', () => {
  const docs = [
    { path: 'wrong.ts', content: 'nothing' },
    { path: 'one.ts', content: 'const x = 1;' },
    { path: 'two.ts', content: 'const x = 1;' },
  ]
  const result = resolveAnchor('const x = 1;', docs, 'wrong.ts')
  assert.equal(result.status, 'unanchored')
  assert.equal(result.tier, 'relocation-ambiguous')
  assert.deepEqual([...result.ambiguousIn].sort(), ['one.ts', 'two.ts'])
})

test('a genuine miss is reported as unanchored, never as a guess', () => {
  const result = resolveAnchor('nothing like this exists', [{ path: 'a.ts', content: 'const x = 1;' }], 'a.ts')
  assert.equal(result.status, 'unanchored')
  assert.equal(result.tier, 'no-match')
})

// ---------------------------------------------------------------------------
console.log('\nP6 loss orientation')
// ---------------------------------------------------------------------------

test('precision-first drops a finding whose evidence falls short', () => {
  const result = runCritiquePanel([{ id: 'f1', severity: 'low', message: 'maybe smells' }], { orientation: 'precision-first' })
  assert.equal(result.kept.length, 0)
  assert.match(result.dropped[0].reason, /falls short of proof/)
})

test('precision-first keeps a defended finding', () => {
  const result = runCritiquePanel([{ id: 'f2', severity: 'high', message: 'nil deref', evidence: 'line 3 dereferences a nil map', defended: true }], { orientation: 'precision-first' })
  assert.equal(result.kept.length, 1)
})

test('recall-first keeps an undecided finding', () => {
  const result = runCritiquePanel([{ id: 'f3', severity: 'low', message: 'possibly unchecked' }], { orientation: 'recall-first' })
  assert.equal(result.kept.length, 1)
  assert.match(result.kept[0].critique, /kept unless positively disproved/)
})

test('recall-first still drops a positively disproved finding', () => {
  const result = runCritiquePanel([{ id: 'f4', severity: 'low', message: 'unchecked', disproved: true }], { orientation: 'recall-first' })
  assert.equal(result.kept.length, 0)
})

test('a protected subject vetoes the correctness judgement in BOTH orientations', () => {
  const finding = { id: 'f5', severity: 'info', subject: 'security', message: 'possibly unsafe' }
  const strict = runCritiquePanel([finding], { orientation: 'precision-first' })
  const loose = runCritiquePanel([finding], { orientation: 'recall-first' })
  assert.equal(strict.kept.length, 1)
  assert.equal(loose.kept.length, 1)
  assert.equal(strict.vetoes, 1)
  assert.match(strict.kept[0].critique, /protected subject/)
})

// ---------------------------------------------------------------------------
console.log('\nP7 coverage')
// ---------------------------------------------------------------------------

test('coverage counts distinct anchored paths', () => {
  const proof = coverage(3, [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }])
  assert.equal(proof.reviewed, 2)
  assert.equal(proof.complete, false)
  assert.equal(proof.coverageRate, Number((2 / 3).toFixed(4)))
})

test('an empty candidate set is fully covered, not zero-percent', () => {
  const proof = coverage(0, [])
  assert.equal(proof.coverageRate, 1)
  assert.equal(proof.complete, true)
})

// ---------------------------------------------------------------------------
console.log('\nend-to-end through the tools')
// ---------------------------------------------------------------------------

test('plan -> anchor -> submit round trip', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const tools = ctx.__tools

  const plan = await tools.get('adjudication_plan').execute({
    domain: 'code-review',
    target: 'PR #1',
    candidates: [
      { path: 'src/app.ts', additions: 12, deletions: 3 },
      { path: 'node_modules/x/index.js' },
      { path: '.env' },
    ],
  }, {})
  assert.equal(plan.gate.admitted, 1)
  assert.equal(plan.gate.excluded.length, 2)

  const anchored = await tools.get('adjudication_anchor').execute({
    excerpt: 'const total = sum(items)',
    path: 'src/app.ts',
    documents: [{ path: 'src/app.ts', content: 'let a = 1\n  const total = sum( items )\nlet b = 2' }],
  }, {})
  assert.equal(anchored.status, 'anchored')
  assert.equal(anchored.start, 2)

  const submitted = await tools.get('adjudication_submit').execute({
    domain: 'code-review',
    target: 'PR #1',
    total: 1,
    findings: [
      { id: 'c1', path: 'src/app.ts', start: 2, severity: 'high', message: 'sum() does not handle empty input', evidence: 'line 2', defended: true },
      { id: 'c2', path: 'src/app.ts', start: 9, severity: 'low', message: 'style nit', evidence: '' },
      { id: 'c3', path: 'src/app.ts', severity: 'high', message: 'unanchored claim' },
    ],
  }, {})

  assert.equal(submitted.unanchored, 1, 'c3 must be excluded as unanchored')
  assert.equal(submitted.dropped.length, 1, 'c2 must be dropped by precision-first')
  assert.equal(submitted.findings.length, 1)
  assert.equal(submitted.domain, 'code-review')
  assert.equal(submitted.lossOrientation, 'precision-first')
  assert.match(submitted.summary, /覆盖率/)
})

test('a recall-first domain flags incomplete coverage as a failure', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'risk-compliance',
    total: 5,
    findings: [{ id: 'r1', path: 'flow-a', start: 1, severity: 'high', message: 'no legal basis recorded', evidence: 'x' }],
  }, {})
  assert.equal(submitted.lossOrientation, 'recall-first')
  assert.match(submitted.summary, /覆盖率不完整|不完整/)
})

test('the domains tool refuses to imply unloaded domains are callable', async () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19)
  assert.match(listed.summary, /adjudication_activate/)
  assert.equal(ctx.__tools.has('adjudicate_code_review'), false)
})

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
