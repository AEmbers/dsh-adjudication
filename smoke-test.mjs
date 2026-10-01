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
import { createMemoryIo } from './lib/domain-loader.js'

let failures = 0
let passes = 0

/**
 * Options that keep this suite measuring the BUILT-IN library. (t4)
 *
 * `apply(ctx, {})` reads the real `domains/` directory, so once a domain ships
 * as a v2 directory package (the migration this package is built around) an
 * unfiltered call starts measuring THAT domain instead of the built-in one:
 * activation returns its extension-point tools alongside the declared ones, and
 * its markdown rule library replaces the pack's inline rules.
 *
 * Every assertion in this file is about the plugin and the built-in library —
 * there is a separate suite for each domain — so discovery is switched off with
 * an empty in-memory io. Discovered packs have their own coverage in
 * `lib/kernel-test.mjs` (which loads real directory packs) and in
 * `domains/<id>/test.mjs`.
 *
 * NOTHING HERE IS RELAXED: each assertion keeps its exact original expectation.
 * What changed is only WHICH library it is measured against.
 */
const EMPTY_DOMAIN_IO = Object.freeze({ domainIo: createMemoryIo({}) })

/**
 * CHANGED (t17): this harness used to call `body()` without awaiting it, so the
 * eight async test bodies below printed "ok" the moment they were *started* and
 * their assertions ran detached. A failing assertion in them surfaced only as an
 * unhandled rejection AFTER the summary line, or not at all. Awaiting is what
 * turns those eight into real tests; it relaxes nothing.
 */
async function test(title, body) {
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
 * Minimal stand-in for the harness context — and, since t47, a FAITHFUL one where
 * services are concerned.
 *
 * THE TRAP THIS CLOSES. `apply()` reads an injected service AS A PROPERTY of the
 * context it is handed — `optionalInject()` does `serviceSlots[name].value =
 * serviceCtx[name]` (index.js:425-426), never `serviceCtx.get(name)`. A mock whose
 * `provide`/`set` only filled a Map, and whose `inject` understood `systemPrompt` alone
 * by hand, silently made every optional-injection path UNREACHABLE: a test written as
 * "with ctx.subagents mounted, activating adds the P4 tool" would have exercised the
 * degraded surface (`mode: 'none'`) and gone GREEN on the wrong path. That is worse
 * than a weak test — a weak test merely misses, this one reports a pass for a path it
 * never entered, and nothing is red to draw the eye. `lib/kernel-test.mjs:159-167`
 * already modelled this correctly (`mounted[name] = services[name]`, then
 * `cb({ ...mounted, effect })`); this mock now does the same, and `provide`/`set`
 * expose the service on the context as well as in the map.
 *
 * `mounted` is the service table a host would have mounted BEFORE `apply()` runs;
 * `systemPrompt` is mounted by default because this suite asserts the optional prompt
 * section. Pass `subagents` / `llm` there to drive the P4 main path — see the t47 block
 * near the bottom of this file, which is the assertion that proves the path is
 * reachable at all.
 *
 * NOT MODELLED, stated rather than papered over: a real `inject` is reactive — a service
 * that mounts LATER re-runs the callback without re-applying the plugin. This mock runs
 * the callback once, at inject time, so a service has to be mounted before `apply()`.
 * The late-mount semantics are covered against `createReasoner` by
 * `lib/kernel-test.mjs:1027`.
 */
function createMockContext(mounted = {}) {
  const tools = new Map()
  const effects = []
  const injected = []
  const services = new Map()
  let injectedCallbacks = 0

  /** Mount a service the way the host does: reachable by property AND by key. */
  const expose = (serviceName, service) => {
    if (service === undefined) {
      services.delete(serviceName)
      delete ctx[serviceName]
      return
    }
    services.set(serviceName, service)
    ctx[serviceName] = service
  }

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

    inject(serviceNames, callback) {
      injected.push(serviceNames)
      // All-or-nothing, exactly like the real `inject`: the callback runs only once
      // EVERY requested service is mounted, and it receives them as properties (plus
      // `effect`, which is how a registration from inside the callback is scoped).
      if (serviceNames.some((serviceName) => !services.has(serviceName))) return
      injectedCallbacks += 1
      const injectedContext = { effect: (fn, label) => ctx.effect(fn, label) }
      for (const serviceName of serviceNames) injectedContext[serviceName] = services.get(serviceName)
      callback(injectedContext)
    },

    provide(key, value) { expose(key, value) },
    set(key, value) { expose(key, value) },
    get(key) { return services.get(key) },

    __tools: tools,
    __effects: effects,
    __services: services,
    __injected: injected,
    __injectedCallbacks: injectedCallbacks,
  }

  // Mount the caller's table first, then the harness's own system-prompt service —
  // through `expose`, i.e. the very path a real host uses. Nothing is special-cased
  // inside `inject` any more: `systemPrompt` reaches the plugin because it is mounted,
  // not because the mock recognises its name.
  for (const [serviceName, service] of Object.entries(mounted)) expose(serviceName, service)
  if (!services.has('systemPrompt')) {
    expose('systemPrompt', {
      section(spec) {
        ctx.__promptSection = spec
        return () => { delete ctx.__promptSection }
      },
    })
  }

  return ctx
}

console.log(`\ndsh-adjudication smoke test\n${'='.repeat(50)}\n`)

// ---------------------------------------------------------------------------
console.log('module shape')
// ---------------------------------------------------------------------------

await test('exports a cordis plugin identity', () => {
  assert.equal(name, 'adjudication')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

await test('every built-in domain pack validates', () => {
  assert.equal(BUILTIN_DOMAINS.length, 19)
  for (const pack of BUILTIN_DOMAINS) {
    assert.deepEqual(validateDomain(pack), [], `domain ${pack.id}`)
  }
})

await test('domain ids are unique', () => {
  assert.equal(new Set(BUILTIN_DOMAINS.map((pack) => pack.id)).size, BUILTIN_DOMAINS.length)
})

await test('the recall-first set is non-empty and every member declares it', () => {
  assert.ok(RECALL_FIRST_DOMAINS.length >= 8, `expected >= 8, got ${RECALL_FIRST_DOMAINS.length}`)
  for (const id of RECALL_FIRST_DOMAINS) {
    const pack = BUILTIN_DOMAINS.find((candidate) => candidate.id === id)
    assert.equal(pack.lossOrientation, 'recall-first')
  }
})

// ---------------------------------------------------------------------------
console.log('\nmount and teardown')
// ---------------------------------------------------------------------------

await test('mounts and registers exactly the six core tools', () => {
  const ctx = createMockContext()
  apply(ctx, { domains: 'all' })
  assert.deepEqual([...ctx.__tools.keys()].sort(), [
    'adjudication_activate', 'adjudication_anchor', 'adjudication_deactivate',
    'adjudication_domains', 'adjudication_plan', 'adjudication_submit',
  ])
})

await test('installs an optional system-prompt section', () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
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

await test('prompt section can be turned off', () => {
  const ctx = createMockContext()
  apply(ctx, { promptSection: false })
  assert.equal(ctx.__promptSection, undefined)
})

await test('honours a domain subset', () => {
  const ctx = createMockContext()
  apply(ctx, { domains: ['code-review', 'ux-review'] })
  assert.equal(ctx.get('adjudication').listDomains().length, 2)
})

await test('the whole plugin unmounts cleanly', () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  assert.ok(ctx.__tools.size >= 6)
  for (const entry of ctx.__effects) {
    if (!entry.undone) entry.dispose?.()
  }
  assert.equal(ctx.__tools.size, 0, 'every tool must be withdrawn on unload')
})

// ---------------------------------------------------------------------------
console.log('\non-demand tool lifecycle (the design claim)')
// ---------------------------------------------------------------------------

await test('domain tools are absent until activated', () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  assert.equal(ctx.__tools.has('adjudicate_code_review'), false)
  assert.equal(ctx.__tools.has('adjudication_activate'), true)
})

await test('activate registers the domain toolset', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  const result = await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.tools.sort(), ['adjudicate_code_review', 'adjudicate_code_review_plan', 'adjudicate_code_review_rules'])
  for (const toolName of result.tools) assert.ok(ctx.__tools.has(toolName), `${toolName} must be registered`)
})

await test('depth=entry registers only the entry tool', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  const result = await ctx.__tools.get('adjudication_activate').execute({ domain: 'ux-review', depth: 'entry' }, {})
  assert.deepEqual(result.tools, ['adjudicate_ux_review'])
})

await test('activating twice is idempotent, not a duplicate-name crash', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  const activate = ctx.__tools.get('adjudication_activate')
  await activate.execute({ domain: 'code-review' }, {})
  const second = await activate.execute({ domain: 'code-review' }, {})
  assert.equal(second.alreadyActive, true)
  assert.equal(second.ok, true)
})

await test('deactivate withdraws exactly that domain', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  await ctx.__tools.get('adjudication_activate').execute({ domain: 'ux-review' }, {})
  await ctx.__tools.get('adjudication_deactivate').execute({ domain: 'code-review' }, {})
  assert.equal(ctx.__tools.has('adjudicate_code_review'), false)
  assert.equal(ctx.__tools.has('adjudicate_ux_review'), true)
  assert.equal(ctx.__tools.has('adjudication_domains'), true, 'core tools survive')
})

await test('activating an unknown domain fails loudly, not silently', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  const result = await ctx.__tools.get('adjudication_activate').execute({ domain: 'nope' }, {})
  assert.equal(result.ok, false)
  assert.match(result.summary, /unknown domain/)
})

await test('a downstream pack registers through the facade', () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
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

await test('the gate is ordered and records why each candidate was dropped', () => {
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

await test('the gate order puts secrets ahead of a user include rule', () => {
  const result = gate([{ path: '.ssh/id_rsa' }], { include: ['**'] })
  assert.equal(result.selected.length, 0)
  assert.equal(result.excluded[0].predicate, 'secret')
})

await test('an explicit include rule short-circuits the convenience exclusions', () => {
  const result = gate([
    { path: 'vendor/lib/keep.ts' },
    { path: 'vendor/lib/other.ts' },
  ], { include: ['vendor/**'], extensions: ['.ts'] })
  assert.deepEqual(result.selected.map((item) => item.path), ['vendor/lib/keep.ts', 'vendor/lib/other.ts'])
  assert.equal(result.selected[0].forcedByInclude, true)
})

await test('glob ** spans separators and * does not', () => {
  const result = gate([
    { path: 'a/b/c.ts' },
    { path: 'a/b/deep/c.ts' },
  ], { exclude: ['a/*/c.ts'] })
  assert.deepEqual(result.selected.map((item) => item.path), ['a/b/deep/c.ts'])
})

// ---------------------------------------------------------------------------
console.log('\nP2 bundling')
// ---------------------------------------------------------------------------

await test('a single candidate short-circuits without a planning call', () => {
  const result = bundle([{ path: 'a.ts' }])
  assert.equal(result.strategy, 'short-circuit-single')
})

await test('fewer than minFiles bundles as one unit', () => {
  const result = bundle([{ path: 'a.ts' }, { path: 'b.ts' }])
  assert.equal(result.strategy, 'short-circuit-small')
  assert.equal(result.bundles.length, 1)
})

await test('a large group degrades to one bundle per entry instead of overflowing', () => {
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

await test('first matching rule wins, in declaration order', () => {
  const rules = [
    { name: 'specific', match: ['**/*.ts'], text: 'specific text' },
    { name: 'general', match: ['**/*'], text: 'general text' },
  ]
  const { injected } = selectRules(rules, ['a.ts'])
  assert.deepEqual(injected.map((rule) => rule.name), ['specific', 'general'])
})

await test('a single matched rule renders unwrapped, for prompt-prefix stability', () => {
  const rendered = renderRules([{ name: 'one', text: 'BODY' }], ['a.ts'])
  assert.equal(rendered, 'BODY')
})

await test('multiple matched rules render inside an attribute-bearing wrapper', () => {
  const rendered = renderRules([{ name: 'a', text: 'A' }, { name: 'b', text: 'B' }], ['x.ts', 'y.ts'])
  assert.equal(rendered, '<rules for="x.ts,y.ts">\nA\n\nB\n</rules>')
})

// ---------------------------------------------------------------------------
console.log('\nP5 anchor resolution')
// ---------------------------------------------------------------------------

await test('normalisation strips diff markers and whitespace', () => {
  assert.equal(normalizeLine('+   const x = 1'), 'constx=1')
  assert.equal(normalizeLine('-  const x = 1'), 'constx=1')
})

await test('consecutive matching is whitespace- and marker-insensitive', () => {
  const haystack = [' a', '+  b', 'c']
  assert.equal(matchConsecutive(haystack, ['a', 'b', 'c']), 0)
})

await test('tier 1 anchors in the declared document', () => {
  // The excerpt is copied VERBATIM, punctuation included. Only indentation and
  // diff markers are forgiven, which is the documented contract.
  const result = resolveAnchor('const x = 1;', [{ path: 'a.ts', content: 'let y\nconst  x = 1;\n' }], 'a.ts')
  assert.equal(result.status, 'anchored')
  assert.equal(result.tier, 'declared-document')
  assert.equal(result.start, 2)
})

await test('a paraphrased excerpt does NOT anchor — strictness is the safety property', () => {
  const result = resolveAnchor('const x = 1', [{ path: 'a.ts', content: 'const x = 1;' }], 'a.ts')
  assert.equal(result.status, 'unanchored')
})

await test('tier 2 relocates only on a unique hit', () => {
  const docs = [
    { path: 'wrong.ts', content: 'nothing here' },
    { path: 'right.ts', content: 'alpha\nconst x = 1;\nbeta' },
  ]
  const result = resolveAnchor('const x = 1;', docs, 'wrong.ts')
  assert.equal(result.status, 'anchored')
  assert.equal(result.tier, 'relocated-unique')
  assert.equal(result.path, 'right.ts')
})

await test('an ambiguous relocation REFUSES to guess', () => {
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

await test('a genuine miss is reported as unanchored, never as a guess', () => {
  const result = resolveAnchor('nothing like this exists', [{ path: 'a.ts', content: 'const x = 1;' }], 'a.ts')
  assert.equal(result.status, 'unanchored')
  assert.equal(result.tier, 'no-match')
})

// ---------------------------------------------------------------------------
console.log('\nP6 loss orientation')
// ---------------------------------------------------------------------------

await test('precision-first drops a finding whose evidence falls short', () => {
  const result = runCritiquePanel([{ id: 'f1', severity: 'low', message: 'maybe smells' }], { orientation: 'precision-first' })
  assert.equal(result.kept.length, 0)
  assert.match(result.dropped[0].reason, /falls short of proof/)
})

await test('precision-first keeps a defended finding', () => {
  const result = runCritiquePanel([{ id: 'f2', severity: 'high', message: 'nil deref', evidence: 'line 3 dereferences a nil map', defended: true }], { orientation: 'precision-first' })
  assert.equal(result.kept.length, 1)
})

await test('recall-first keeps an undecided finding', () => {
  const result = runCritiquePanel([{ id: 'f3', severity: 'low', message: 'possibly unchecked' }], { orientation: 'recall-first' })
  assert.equal(result.kept.length, 1)
  assert.match(result.kept[0].critique, /kept unless positively disproved/)
})

await test('recall-first still drops a positively disproved finding', () => {
  const result = runCritiquePanel([{ id: 'f4', severity: 'low', message: 'unchecked', disproved: true }], { orientation: 'recall-first' })
  assert.equal(result.kept.length, 0)
})

await test('a protected subject vetoes the correctness judgement in BOTH orientations', () => {
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

await test('coverage counts distinct anchored paths', () => {
  const proof = coverage(3, [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }])
  assert.equal(proof.reviewed, 2)
  assert.equal(proof.complete, false)
  assert.equal(proof.coverageRate, Number((2 / 3).toFixed(4)))
})

await test('an empty candidate set is fully covered, not zero-percent', () => {
  const proof = coverage(0, [])
  assert.equal(proof.coverageRate, 1)
  assert.equal(proof.complete, true)
})

// ---------------------------------------------------------------------------
console.log('\nend-to-end through the tools')
// ---------------------------------------------------------------------------

await test('plan -> anchor -> submit round trip', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
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
    // CHANGED (t17): `documents` is now REQUIRED for a finding to be able to
    // anchor — the engine recomputes every anchor through the domain verifier
    // (here: the generic ladder, since the built-in v1 pack declares none) and
    // ignores the caller's `anchored`/`start`. The three expectations below are
    // untouched; what changed is that the input now has to be honest:
    //   • c1 quotes its line verbatim, so it really anchors at line 2;
    //   • c2 quotes a line too, so it anchors and is then DROPPED by
    //     precision-first for lacking defence (that is what this test measures);
    //   • c3 quotes nothing, so it stays unanchored.
    // Before, `evidence: 'line 2'` and `evidence: ''` were accepted as anchors on
    // the caller's word — which is exactly the self-report F3 removed.
    documents: [{ path: 'src/app.ts', content: 'let a = 1\n  const total = sum( items )\nlet b = 2' }],
    findings: [
      { id: 'c1', path: 'src/app.ts', start: 2, severity: 'high', message: 'sum() does not handle empty input', evidence: 'const total = sum(items)', defended: true },
      { id: 'c2', path: 'src/app.ts', start: 1, severity: 'low', message: 'style nit', evidence: 'let a = 1' },
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

await test('a recall-first domain flags incomplete coverage as a failure', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  const submitted = await ctx.__tools.get('adjudication_submit').execute({
    domain: 'risk-compliance',
    total: 5,
    // CHANGED (t17): same reason as the round trip above — an anchor now has to
    // be recomputable, so the finding quotes its line and the document is given.
    // The two expectations are unchanged.
    documents: [{ path: 'flow-a', content: 'no legal basis recorded' }],
    findings: [{ id: 'r1', path: 'flow-a', start: 1, severity: 'high', message: 'no legal basis recorded', evidence: 'no legal basis recorded' }],
  }, {})
  assert.equal(submitted.lossOrientation, 'recall-first')
  assert.match(submitted.summary, /覆盖率不完整|不完整/)
})

await test('the domains tool refuses to imply unloaded domains are callable', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)
  const listed = await ctx.__tools.get('adjudication_domains').execute({}, {})
  assert.equal(listed.count, 19)
  assert.match(listed.summary, /adjudication_activate/)
  assert.equal(ctx.__tools.has('adjudicate_code_review'), false)
})

// ---------------------------------------------------------------------------
console.log('\nservice injection — the mock must not be able to fake a path (t47)')
// ---------------------------------------------------------------------------
//
// READ THIS BEFORE ADDING A SERVICE-DEPENDENT ASSERTION HERE.
//
// This mock used to keep provided services in a Map and to hand-build the
// `systemPrompt` injection by name, while `apply()` reads an injected service as a
// PROPERTY of the context (index.js:425-426). Anything driven by a service therefore
// could not be reached from this file, and an assertion like "mount subagents, then
// activating adds the P4 tool" would have measured the DEGRADED surface and passed.
// Both assertions below exist to keep that from coming back:
//
//   • the NEGATIVE CONTROL pins what the degraded path looks like on purpose
//     (`mode: 'none'`, no P4 tool) — so the degradation is never mistaken for coverage;
//   • the MAIN PATH test mounts `subagents` through the same generic table and proves
//     the P4 surface really appears, which is the property the trap used to hide.
//
// If you add `subagents`/`llm` to an assertion here, mount it via
// `createMockContext({ subagents: … })` — do NOT expect the mock to invent a service.

await test('DEGRADATION PATH (negative control): no reasoning service means mode "none", not a P4 tool', async () => {
  const ctx = createMockContext()
  apply(ctx, EMPTY_DOMAIN_IO)

  // The engine's own words for "nobody mounted a reasoner": this is the v1 surface,
  // and it is asserted here as a BOUNDARY — not as evidence that P4 was exercised.
  const described = ctx.get('adjudication').reasoner.describe()
  assert.equal(described.available, false)
  assert.equal(described.mode, 'none')
  assert.equal(described.degraded, true)
  assert.match(described.reason, /neither ctx\.subagents nor ctx\.llm/u)

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  assert.deepEqual(activated.tools.sort(), [
    'adjudicate_code_review', 'adjudicate_code_review_plan', 'adjudicate_code_review_rules',
  ], 'a host with no reasoning service keeps exactly the v1 toolset (index.js:754-758)')
  assert.equal(activated.tools.includes('adjudicate_code_review_review'), false)
})

await test('MAIN PATH: a mounted ctx.subagents reaches the P4 tool through the generic inject', async () => {
  const calls = []
  const ctx = createMockContext({
    subagents: {
      async start(request) {
        calls.push(request)
        return {
          id: 'child-1',
          result: Promise.resolve({
            stopReason: 'completed',
            structured: { findings: [{ id: 'f1', path: 'src/a.ts', start: 1, message: 'm', evidence: 'e' }] },
            output: [],
          }),
          dispose: async () => {},
        }
      },
    },
  })
  apply(ctx, EMPTY_DOMAIN_IO)

  assert.equal(ctx.get('adjudication').reasoner.describe().mode, 'subagents',
    'the injected context must expose the service as a property — this is the assertion the old mock could not satisfy')

  const activated = await ctx.__tools.get('adjudication_activate').execute({ domain: 'code-review' }, {})
  assert.ok(activated.tools.includes('adjudicate_code_review_review'),
    `the P4 tool must appear once a reasoner is mounted, got ${JSON.stringify(activated.tools)}`)

  const outcome = await ctx.__tools.get('adjudicate_code_review_review').execute({
    target: 'PR#1',
    candidates: [{ path: 'src/a.ts', additions: 1 }],
  }, {})
  assert.equal(outcome.mode, 'subagents')
  assert.equal(calls.length, 1, 'exactly one bounded pass for one bundle')
  assert.equal(calls[0].parent, undefined, 'no exec.agent in this harness')
})

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`)
console.log(`${passes} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
