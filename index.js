/**
 * dsh-adjudication — a multi-domain adjudication engine for DeepSeek Harness.
 *
 * DESIGN IN ONE PARAGRAPH
 * -----------------------
 * The engine (`lib/engine.js`) is domain-blind and deterministic: it enumerates,
 * gates, bundles, injects rules, resolves anchors, applies a declared loss
 * orientation and accounts for coverage. The domains (`lib/domains.js`) are pure
 * data. This module is the seam between them and the model, and it is built
 * around one idea: **the tool surface is discovered, not declared**.
 *
 * Six small tools are always present. Nineteen domains × three tools each are
 * NOT — they are registered on demand, per domain, when the model actually needs
 * that domain, and disposed again when it does not. A profile carrying this
 * plugin therefore pays for six tool schemas, not sixty-three, while every
 * domain's full capability stays one `adjudication_activate` call away. Adding a
 * twentieth domain in a downstream package adds zero schemas to the common path.
 *
 * Deliberate implementation note: this module has **no runtime imports**. That
 * is not stylistic. A plugin installed from a local path is `link:`-ed by pnpm,
 * which does not install its dependencies; a non-`@deepseek-ai/dsh-*` peer is
 * not guaranteed to be mapped by the profile's runtime resolver. Depending on
 * nothing is what makes the bundle load everywhere. The cost is that there is no
 * exported Schemastery `Config` — `apply(ctx, config)` merges a plain options
 * object instead. See README "Known limitations".
 */

import {
  createRegistry,
  DOMAIN_CATEGORIES,
  entryToolName,
  domainToolNames,
  slug,
  validateDomain,
} from './lib/registry.js'
import { BUILTIN_DOMAINS, selectDomains } from './lib/domains.js'
import {
  createNodeIo,
  describeDomainDirectory,
  loadDomains,
  registerLoadedDomains,
} from './lib/domain-loader.js'
import { createReasoner, REASONER_CODES } from './lib/reasoner.js'
import {
  CRITICISM_KINDS,
  DEFAULT_CRITICISM_KIND,
  ERROR_CODES,
  contractError,
  evidenceToolName,
  resolveBundleKey,
  ruleLibraryKind,
  rulesOf,
  validateAnchorVerdict,
  validateCandidateSetResult,
  validateEvidenceResult,
} from './lib/contracts.js'
import {
  BUNDLE_DEFAULTS,
  LOSS_ORIENTATIONS,
  bundle,
  charge,
  createBudget,
  coverage,
  gate,
  markSecrets,
  renderRules,
  report,
  resolveAnchor,
  runCritiquePanel,
  selectRules,
  validatedEngineVerdict,
} from './lib/engine.js'

export const name = 'adjudication'

/** Only `tools` is required. `systemPrompt` is taken opportunistically below. */
export const inject = ['tools']

/** Plain defaults; `config` from the cordis row is merged over these. */
export const DEFAULT_OPTIONS = {
  domains: 'all',
  domainTools: 'full',
  gate: { maxCandidates: 400, maxFileBytes: 1_048_576 },
  bundle: { ...BUNDLE_DEFAULTS },
  budget: { maxToolCalls: 100, maxExcerptLines: 500, maxSearchHits: 100 },
  lossOrientation: 'precision-first',
  promptSection: true,
  promptSectionOrder: 118,
  /**
   * Contract v2 runtime.
   *
   * `domainRoot`  — where `domains/<id>/` directories are discovered. Discovery
   *                 is lazy (first tool call) and total: a missing root is an
   *                 empty result, never a failure, so the nineteen v1 packs keep
   *                 shipping unchanged while owners migrate one at a time.
   * `domainIo`    — a host-supplied `{readDir, readFile, exists, toUrl}`. When
   *                 absent a lazily-constructed node io is used, so the package
   *                 still imports nothing at load time.
   * `loadModule`  — module loader for domain entry files (tests inject a stub).
   * `bundleKey`   — how `pack.bundleKey` becomes an actual grouping key. The
   *                 default trusts the strategies the built-in packs declare
   *                 (`'directory'`); unknown names fall back to per-path
   *                 grouping and say so.
   * `reasoner`    — P4 executor bounds. Never enables itself: a missing
   *                 `ctx.subagents`/`ctx.llm` degrades to `mode: 'none'`.
   */
  domainRoot: 'domains',
  domainIo: undefined,
  loadModule: undefined,
  bundleKey: { trustDeclaredStrategies: true, strategies: {}, params: {} },
  reasoner: { provider: null, model: null, maxRounds: 8, maxPromptChars: 24_000, maxFindings: 200 },
}

const CORE_TOOL_NAMES = [
  'adjudication_domains',
  'adjudication_activate',
  'adjudication_deactivate',
  'adjudication_plan',
  'adjudication_anchor',
  'adjudication_submit',
]

/**
 * The most recently mounted registry.
 *
 * Downstream packages have two ways to contribute a domain, and they should
 * pick whichever their host supports:
 *
 *   1. service lookup — `ctx.get('adjudication')` (whatever service key the
 *      running host honours)
 *   2. this accessor — `import { getSharedRegistry } from 'dsh-adjudication'`
 *
 * The second exists because this plugin deliberately imports nothing, so it
 * cannot construct a Cordis `Service`; and because a profile may mount the
 * bundle more than once, where the last mount is the one a co-mounted pack
 * belongs to.
 */
let sharedRegistry = null

/** @returns {object|null} the registry of the most recently applied instance */
export function getSharedRegistry() {
  return sharedRegistry
}

/** @returns {object|null} the full facade, including the engine primitives */
export function getSharedAdjudication() {
  return sharedFacade
}

let sharedFacade = null

// ---------------------------------------------------------------------------
// Small local helpers — the parts a Schemastery `Config` and `defineTool` would
// have given us, written out so the plugin stays dependency-free.
// ---------------------------------------------------------------------------

function mergeOptions(config) {
  const raw = config ?? {}
  return {
    ...DEFAULT_OPTIONS,
    ...raw,
    gate: { ...DEFAULT_OPTIONS.gate, ...(raw.gate ?? {}) },
    bundle: { ...DEFAULT_OPTIONS.bundle, ...(raw.bundle ?? {}) },
    budget: { ...DEFAULT_OPTIONS.budget, ...(raw.budget ?? {}) },
    bundleKey: { ...DEFAULT_OPTIONS.bundleKey, ...(raw.bundleKey ?? {}) },
    reasoner: { ...DEFAULT_OPTIONS.reasoner, ...(raw.reasoner ?? {}) },
  }
}

/**
 * Compact parameter spec -> JSON Schema object. `{ path: { type: 'string',
 * required: true, description: '...' } }` becomes the implicit-open-object
 * rooted schema the tool registry expects.
 */
function params(spec) {
  const properties = {}
  const required = []
  for (const [key, definition] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = definition
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/** Registration-time validation, mirroring the harness's own contract. */
function defineTool(spec) {
  if (typeof spec?.name !== 'string' || spec.name === '') {
    throw new TypeError('a tool must declare a non-empty name')
  }
  if (typeof spec.description !== 'string' || spec.description === '') {
    throw new TypeError(`tool "${spec.name}" must declare a description`)
  }
  if (spec.output === null || typeof spec.output !== 'object' || spec.output.schema === undefined) {
    throw new TypeError(`tool "${spec.name}" must declare output { schema, render? }`)
  }
  if (spec.output.render !== undefined && typeof spec.output.render !== 'function') {
    throw new TypeError(`tool "${spec.name}" output.render must be a function`)
  }
  if (typeof spec.execute !== 'function') {
    throw new TypeError(`tool "${spec.name}" must declare execute()`)
  }
  return {
    ...spec,
    output: { render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...spec.output },
  }
}

const text = (value) => [{ type: 'text', text: value }]
const bullet = (items) => items.map((item) => `- ${item}`).join('\n')

/**
 * Coerce a model-supplied document array into the engine's shape.
 *
 * CHANGED (t17): every other field on the document is PRESERVED. A document is
 * not only `{path, content}` — graph-shaped domains carry the graph itself here
 * (node/edge payloads, environment snapshots, API captures), and a verifier that
 * anchors against a graph needs it. The first version kept only two keys, which
 * silently starved those verifiers of their subject.
 */
function toDocuments(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((doc) => doc !== null && typeof doc === 'object' && typeof doc.path === 'string')
    .map((doc) => ({ ...doc, path: doc.path, content: typeof doc.content === 'string' ? doc.content : '' }))
}

/**
 * Coerce a model-supplied candidate array.
 *
 * CHANGED (t17): like `toDocuments`, every other field is PRESERVED. A candidate
 * is not only a file path — a graph/clause/flow domain attaches its own
 * `locator` (and often `title`/`meta`) here, and that is exactly what its
 * `bundleKey.resolve` and gate predicates read. The earlier version kept seven
 * keys and silently dropped the rest, which is the same defect class as the
 * locator/documents losses fixed in this task.
 */
function toCandidates(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item) => item !== null && typeof item === 'object' && typeof item.path === 'string')
    .map((item) => {
      const candidate = { ...item }
      candidate.bytes = typeof item.bytes === 'number' ? item.bytes : undefined
      candidate.additions = typeof item.additions === 'number' ? item.additions : 0
      candidate.deletions = typeof item.deletions === 'number' ? item.deletions : 0
      candidate.binary = item.binary === true
      candidate.deleted = item.deleted === true
      if (typeof item.key === 'string') candidate.key = item.key
      return candidate
    })
}

/**
 * Structured-output schema for one P4 pass. Deliberately loose: a provider that
 * cannot honour it is retried without it and the pass is reported as degraded,
 * so the schema must never be the reason a pass is impossible.
 */
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: '每条发现：{ id, path, start, end, anchored, severity, subject, message, evidence }',
      items: { type: 'object' },
    },
  },
  required: ['findings'],
}

/**
 * The tool whitelist a P4 child may use: this domain's own evidence tools and
 * nothing else. A domain with no evidence tools gets no filter at all, which is
 * honest — there is nothing to narrow.
 */
function evidenceToolFilter(pack) {
  const tools = pack?.evidenceTools?.tools
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return { allow: tools.map((tool) => evidenceToolName(pack.id, tool.name)) }
}

/**
 * The tool whitelist a P6 child gets: NOTHING.
 *
 * CHANGED (t41) — the other half of `evidenceToolFilter`. P6 is the independent
 * re-check: it judges the findings it is handed. Letting it re-investigate with
 * the same domain instruments it is checking makes the check circular, and until
 * t41 nothing asserted either half — `evidenceToolFilter` was wired into P4 only.
 *
 * `{ allow: [] }` is sent EXPLICITLY rather than omitted, because omitting a
 * filter means "no restriction" to the host, which is the opposite of what P6
 * needs. If a provider cannot honour a tool filter, `startSubagent` drops it and
 * reports `degraded: true` instead of pretending the restriction held.
 */
function verifyToolFilter() {
  return { allow: [] }
}

/**
 * The structured output a P6 pass is asked for. Deliberately NOT the findings
 * schema: P6 does not produce findings, it produces a judgement of the ones it
 * was given (`keep` / `reason` per id).
 */
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      description: '每条被复核发现的裁决：{ id, keep, reason }',
      items: { type: 'object' },
    },
  },
  required: ['verdicts'],
}

/**
 * Which keys of a domain's anchor VERDICT may travel to P6 on the finding.
 *
 * CHANGED (t41) — the fold used to copy seven fields and nothing else, so a
 * domain's own verdict metadata was dropped on the floor. `requirement-alignment`
 * renders `basis=<refBasis> refDomain=<refDomain>` in its P6 text
 * (`domains/requirement-alignment/prompts.js`), and measured over the whole
 * repository `refDomain/refBasis/refBasisDetail` appeared in `index.js` and
 * `lib/*.js` ZERO times — so even a working P6 renderer would have shown
 * `(未给出)` forever. That is why the renderer and this list are one change.
 *
 * It is a WHITELIST, not a spread. P6's independence means P4's material must be
 * unreachable from a finding, and a blanket spread would put whatever a verifier
 * (or a caller's `findings` entry) happened to carry — including keys shaped like
 * `ruleText` or a work order — into the P6 prompt.
 */
const P6_VERDICT_FIELDS = Object.freeze([
  'code', 'detail', 'tier', 'locator', 'scope', 'stale', 'staleCheck', 'ambiguousIn',
  'ref', 'refDomain', 'refForm', 'refBasis', 'refBasisDetail',
])

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const options = mergeOptions(config)

  const registry = createRegistry({ strict: false })
  // The ledger is reassigned, not mutated: `charge` is pure, so the running
  // total lives here rather than inside the budget object.
  let ledger = createBudget(options.budget)

  /** domain id -> disposer for that domain's dynamically registered tools. */
  const activated = new Map()
  /** domain id -> the tool names currently registered for it. */
  const activatedTools = new Map()
  /**
   * domain id -> `{ admitted, target }` from the last plan of that domain.
   *
   * CHANGED (t17): the coverage denominator must not be a purely self-reported
   * number. `adjudication_plan` is where the engine itself counts admissions, so
   * that count is remembered here and used as a FLOOR at submit time.
   */
  const plannedAdmissions = new Map()

  /**
   * domain id -> the candidate set the last plan ADMITTED, verbatim.
   *
   * CHANGED (t21): `docs/domain-contract-v2.md` §1.2 declares
   * `subject.candidates` ("P0 产出，locator 空间在这里") and the engine had never
   * supplied it. A verifier that recomputes its structural half from the
   * enumerated candidate set — `risk-compliance` reads `{clauseId, surfaceId}`
   * pairs out of it; the ID/graph/table/flow families enumerate exactly the
   * facts they claim about — therefore starved silently on the plugin path
   * (`unanchored/no-documents`) while its own unit tests, which call
   * `verify(claim, <hand-built subject>)` directly, stayed green.
   *
   * Supplying it invents nothing: these are the domain's OWN objects, produced
   * by the domain's OWN `source.js` from the caller's payload, and the engine
   * treats every entry as opaque. That is the difference between handing the
   * caller's material through and constructing domain-shaped data — the engine
   * may do the first and must never do the second.
   */
  const planCandidates = new Map()

  /**
   * `<domain>::<tool>` -> how many times that evidence tool has been called since
   * the domain was last activated.
   *
   * CHANGED (t37) — `limits.maxCalls` used to be a declaration nobody executed:
   * `lib/contracts.js` rejected a value above the hard ceiling and
   * `normaliseEvidenceLimits` clamped it, but no reader ever counted calls, so a
   * tool declaring `maxCalls: 4` could be called four hundred times. A number
   * that reads like a bound and bounds nothing is exactly the failure family this
   * program keeps killing (cf. the anchor `kind` parameter, t24-F5).
   *
   * It is now REALLY enforced, per domain activation, keyed by domain id so two
   * domains that both name a tool `excerpt` do not share a budget. The counters
   * are reset by `adjudication_activate` / `adjudication_deactivate`, which is
   * what makes them a per-review budget rather than a per-process total — the
   * per-process total is the ledger's `maxToolCalls`.
   */
  const evidenceCalls = new Map()

  // --- built-in library -----------------------------------------------------
  const builtins = selectDomains(options.domains)
  for (const pack of builtins) {
    const problems = validateDomain(pack)
    if (problems.length > 0) {
      ctx.logger?.warn?.(`[adjudication] skipping built-in domain "${pack.id}": ${problems.join('; ')}`)
      continue
    }
    registry.register(pack)
  }

  // --- optional reasoning services (P4) ------------------------------------
  // These are acquired through `ctx.inject` and NEVER through the static
  // `inject` export. A missing service in `inject` fails the whole fiber, and
  // Cordis then rolls back every tool this plugin just registered — the same
  // class of accident as the `ctx.set`-without-`provide` throw documented in
  // the README. Optional work must not be able to kill the plugin.
  const serviceSlots = { subagents: { value: undefined }, llm: { value: undefined } }
  const optionalInject = (serviceName) => {
    if (typeof ctx.inject !== 'function') return
    try {
      ctx.inject([serviceName], (serviceCtx) => {
        try {
          if (serviceCtx?.[serviceName] === undefined) return
          serviceSlots[serviceName].value = serviceCtx[serviceName]
          if (typeof serviceCtx.effect === 'function') {
            serviceCtx.effect(() => () => { serviceSlots[serviceName].value = undefined }, `adjudication.inject(${serviceName})`)
          }
        } catch {
          // A host quirk while reading an optional service is not fatal.
        }
      })
    } catch {
      // Hosts without optional injection simply never provide the service.
    }
  }
  optionalInject('subagents')
  optionalInject('llm')

  /** P4 executor. Its availability is read per call, so late mounts count. */
  const reasoner = createReasoner(
    () => ({ subagents: serviceSlots.subagents.value, llm: serviceSlots.llm.value }),
    options.reasoner,
  )

  // --- domain directories (contract v2, §4) --------------------------------
  // Lazy and total: discovery runs on the first tool call, a missing
  // `domains/` directory yields zero packs, and a broken domain is reported
  // and skipped rather than taking the plugin down. The nineteen v1 packs in
  // `lib/domains.js` therefore keep working exactly as before, and a domain
  // owner migrates by creating `domains/<id>/` — nothing shared is edited.
  const directoryState = { status: 'idle', result: null }
  async function ensureDirectoryDomains() {
    if (directoryState.status === 'ready' || directoryState.status === 'failed') return directoryState.result
    if (directoryState.status === 'loading') return directoryState.result
    directoryState.status = 'loading'
    let result
    try {
      const io = options.domainIo ?? await createNodeIo({ baseUrl: new URL('.', import.meta.url).href })
      result = await loadDomains(io, {
        root: options.domainRoot,
        strict: false,
        loadModule: options.loadModule,
      })
      const registration = registerLoadedDomains(registry, result, {
        onError: (problem) => result.problems.push(problem),
      })
      result.added = registration.added
      result.replaced = registration.replaced
      for (const problem of result.problems) {
        ctx.logger?.warn?.(`[adjudication] domains/${problem.id}: ${problem.problems.join('; ')}`)
      }
      directoryState.status = 'ready'
    } catch (error) {
      // A missing or unreadable domain root is the normal case today, not an error.
      result = {
        root: options.domainRoot, packs: [], loaded: [], skipped: [], added: [], replaced: [],
        problems: [{ id: '(root)', problems: [error?.message ?? String(error)] }],
      }
      ctx.logger?.warn?.(`[adjudication] domain directory disabled: ${result.problems[0].problems[0]}`)
      directoryState.status = 'failed'
    }
    directoryState.result = result
    return result
  }

  // --- engine facade --------------------------------------------------------
  // Exposed as a plain object on the plugin context so a downstream cordis
  // plugin row can contribute a domain without importing anything from us:
  //
  //   export const inject = ['adjudication']
  //   export function apply(ctx) {
  //     ctx.effect(() => ctx.adjudication.registerDomain({ ...pack }), 'my-domain')
  //   }
  const facade = {
    version: '0.1.0',
    contractVersion: 2,
    registerDomain: (pack) => registry.register(pack),
    registerDomains: (packs) => registry.registerAll(packs),
    listDomains: () => registry.list(),
    getDomain: (id) => registry.get(id),
    engine: {
      gate, bundle, selectRules, renderRules, resolveAnchor,
      runCritiquePanel, coverage, report, createBudget, charge,
    },
    /** P4: the bounded inference executor, usable by hosts and downstream packs. */
    reasoner: {
      describe: () => reasoner.describe(),
      run: (request) => reasoner.run(request),
    },
    /** Directory discovery state (null until the first tool call). */
    domainDirectory: () => directoryState.result,
    get ledger() { return ledger },
    options,
  }
  sharedRegistry = registry
  sharedFacade = facade

  /**
   * Publish a service to downstream plugin rows.
   *
   * Two host behaviours are in play and neither may be assumed: a Cordis
   * `Context.set(name, value)` THROWS (`cannot set property "x" without
   * provide`) unless the name was `provide`d on that context first, and some
   * hosts expose only one of the two. So every spelling is attempted in order
   * and a failure is simply the next spelling's turn — never the plugin's
   * problem. Getting this wrong is fatal, not cosmetic: an unguarded throw in
   * `apply` leaves the fiber FAILED and Cordis rolls back every tool the plugin
   * just registered.
   */
  const publish = (key, value) => {
    if (typeof ctx.provide === 'function') {
      try {
        ctx.provide(key, value)
        return 'provide'
      } catch {
        /* fall through to set */
      }
    }
    if (typeof ctx.set === 'function') {
      try {
        ctx.set(key, value)
        return 'set'
      } catch {
        /* unavailable on this host */
      }
    }
    return undefined
  }

  const publishedAs = publish('adjudication', facade)
  publish('adjudicationActivation', {
    activate,
    deactivate,
    activeDomains: () => [...activated.keys()],
  })

  // --- domain activation ----------------------------------------------------
  /** CHANGED (t37): one activation = one fresh `maxCalls` budget per tool. */
  function resetEvidenceCalls(domainId) {
    const prefix = `${domainId}::`
    for (const key of [...evidenceCalls.keys()]) {
      if (key.startsWith(prefix)) evidenceCalls.delete(key)
    }
  }

  function activate(domainId, depth) {
    const pack = registry.get(domainId)
    if (pack === undefined) {
      return { ok: false, reason: `unknown domain "${domainId}" — call adjudication_domains to list the registry` }
    }
    const existing = activated.get(domainId)
    if (existing !== undefined) {
      return { ok: true, alreadyActive: true, domain: domainId, tools: activatedTools.get(domainId) ?? [] }
    }
    resetEvidenceCalls(domainId)

    const wanted = depth === 'entry' ? domainToolNames(domainId).slice(0, 1) : domainToolNames(domainId)
    const definitions = buildDomainTools(pack, wanted)

    // One disposer for the whole domain: activation is atomic, and unloading
    // the plugin (or deactivating the domain) withdraws every tool at once.
    const dispose = ctx.effect(function* registerDomainTools() {
      const names = []
      for (const definition of definitions) {
        yield ctx.tools.register(definition)
        names.push(definition.name)
      }
      activatedTools.set(domainId, names)
    }, `adjudication.activate(${domainId})`)

    activated.set(domainId, dispose)
    return { ok: true, alreadyActive: false, domain: domainId, tools: definitions.map((definition) => definition.name) }
  }

  function deactivate(domainId) {
    const dispose = activated.get(domainId)
    if (dispose === undefined) {
      return { ok: true, changed: false, domain: domainId, reason: 'not active' }
    }
    const names = activatedTools.get(domainId) ?? []
    dispose()
    activated.delete(domainId)
    activatedTools.delete(domainId)
    resetEvidenceCalls(domainId)
    return { ok: true, changed: true, domain: domainId, tools: names }
  }

  // --- per-domain tools -----------------------------------------------------
  function buildDomainTools(pack, wantedNames) {
    const label = pack.title
    const orientationNote = pack.lossOrientation === 'recall-first'
      ? '本领域是 recall-first：证据不足时保留并标注存疑，只有被正面否定才丢弃。'
      : '本领域是 precision-first：证据不足以证明时不要提出。'

    const definitions = []

    definitions.push(defineTool({
      name: entryToolName(pack.id),
      description: `${label} — 用本领域的规则库与锚点定义，对给定候选集出具有界的审定工作单（P0–P3），并返回本领域的角色与损失取向。激活状态下可直接调用。`,
      parameters: params({
        target: { type: 'string', description: '被审对象的一句话描述（变更集、流程名、实验 ID 等）' },
        candidates: {
          type: 'array',
          description: '候选集：每项 { path, bytes?, additions?, deletions?, deleted?, binary?, key? }',
          items: { type: 'object', additionalProperties: true },
        },
        input: {
          type: 'object',
          description: '文档化输入（与 candidates 二选一）：{ format, payload }。仅在领域实现了 candidateSource 时可用。',
          additionalProperties: true,
        },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        return planFor(pack, { target: args.target, candidates: args.candidates, input: args.input })
      },
    }))

    if (wantedNames.length > 1) {
      definitions.push(defineTool({
        name: `adjudicate_${slug(pack.id)}_plan`,
        description: `${label} — 只跑 P0–P3：闸门、分捆、规则注入，返回工作单，不含领域角色文本。`,
        parameters: params({
          target: { type: 'string', description: '被审对象的一句话描述' },
          candidates: { type: 'array', description: '候选集', items: { type: 'object', additionalProperties: true } },
          input: { type: 'object', description: '文档化输入（与 candidates 二选一）：{ format, payload }', additionalProperties: true },
        }),
        output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
        async execute(args) {
          return planFor(pack, { target: args.target, candidates: args.candidates, input: args.input })
        },
      }))

      definitions.push(defineTool({
        name: `adjudicate_${slug(pack.id)}_rules`,
        description: `${label} — 列出本领域的规则库（名称、匹配范围、正文）与锚点定义，供人工扩充规则时参考。`,
        parameters: params({}),
        output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
        async execute() {
          // CHANGED (t17): one accessor for "the pack's rules", shared with
          // planFor()'s P3 injection and the registry overview. This reader was
          // already correct; the point is that it no longer has its own copy of
          // the answer, so it cannot drift from the other two again.
          const source = rulesOf(pack)
          const rules = source.map((rule) => ({
            name: rule.name,
            match: Array.isArray(rule.match) ? rule.match : [rule.match],
            text: rule.text,
          }))
          const summary = [
            `# ${label}（${pack.id}）规则库`,
            '',
            `锚点：${pack.anchor?.kind} — ${pack.anchor?.description ?? ''}`,
            `损失取向：${pack.lossOrientation}　复核者：${pack.criticism?.kind ?? '(未声明)'}`,
            `规则条数：${rules.length}（规则库状态：${pack.rulesStatus ?? ruleLibraryKind(pack)}）`,
            '',
            '⚠️ 规则库由 agent 起草并标注 needs-expert-review: true，**未经领域专家审定**。',
            '',
            rules.length === 0
              ? '本领域尚未提供规则。引擎、闸门与锚点均可用，但判定缺少书面依据。'
              : rules.map((rule) => `## ${rule.name}\n匹配：${rule.match.join(', ')}\n\n${rule.text}`).join('\n\n'),
          ].join('\n')
          return { domain: pack.id, rules, summary }
        },
      }))
    }

    // --- per-domain evidence tools (P7, bounded, loaded only on activation) ---
    // Nothing here is registered eagerly: a domain's evidence tools appear when
    // the domain is activated and vanish with it. That is the whole on-demand
    // design, and it is why a profile pays for six schemas, not sixty-three.
    const extensionDefinitions = []
    const evidenceSpecs = pack.evidenceTools?.tools
    if (Array.isArray(evidenceSpecs) && evidenceSpecs.length > 0 && wantedNames.length > 1) {
      for (const spec of evidenceSpecs) {
        extensionDefinitions.push(defineTool({
          name: evidenceToolName(pack.id, spec.name),
          description: `${label} — 领域取证工具（有界：≤${spec.limits.maxLines} 行 / ≤${spec.limits.maxItems} 条 / ≤${spec.limits.maxCalls} 次调用）。${spec.description}`,
          parameters: spec.parameters ?? { type: 'object', properties: {} },
          output: spec.output ?? { schema: { type: 'object' } },
          async execute(args, exec) {
            if (exec?.signal?.aborted === true) {
              throw contractError(ERROR_CODES.E_ABORTED, `取证工具 ${spec.name} 在开始前被取消`)
            }
            if (ledger.exhausted === true) {
              throw contractError(ERROR_CODES.E_BUDGET_EXHAUSTED, `工具调用预算已用尽（${ledger.settings.maxToolCalls} 次）`)
            }
            // CHANGED (t37): `maxCalls` is ENFORCED here, not merely declared.
            // The counter is per domain activation (see `evidenceCalls`), and the
            // cap is the domain's own normalised declaration — never the engine's
            // ceiling, which only validates that the declaration is admissible.
            const callKey = `${pack.id}::${spec.name}`
            const usedCalls = (evidenceCalls.get(callKey) ?? 0) + 1
            const maxCalls = Number(spec.limits?.maxCalls)
            if (Number.isFinite(maxCalls) && maxCalls > 0 && usedCalls > maxCalls) {
              throw contractError(
                ERROR_CODES.E_BUDGET_EXHAUSTED,
                `取证工具 ${spec.name} 超出本领域声明的调用上限（maxCalls=${maxCalls}）——`
                + ' 声明即约束：重新激活该领域以开始新一轮，或改用更少的取证调用。',
              )
            }
            evidenceCalls.set(callKey, usedCalls)
            ledger = charge(ledger, { toolCalls: 1, text: JSON.stringify(args ?? {}).slice(0, 500) })
            const result = await spec.execute(args ?? {}, {
              budget: {
                toolCalls: ledger.toolCalls, tokens: ledger.tokens,
                maxToolCalls: ledger.settings.maxToolCalls, note: ledger.note,
              },
              signal: exec?.signal,
              domain: pack.id,
              pack,
            })
            const problems = validateEvidenceResult(result, spec.limits)
            const items = Array.isArray(result?.items) ? result.items : []
            return {
              ...result,
              domain: pack.id,
              tool: spec.name,
              problems,
              summary: [
                `# ${label} — ${spec.name}`,
                `返回 ${items.length} 条${result?.truncated === true ? '（结果已截断）' : ''}${result?.provenance ? `，出处 ${result.provenance}` : ''}`,
                problems.length === 0 ? '' : `⚠️ 结果不符合契约：${problems.join('; ')}`,
              ].filter(Boolean).join('\n'),
            }
          },
        }))
      }
    }

    // --- P4 bounded inference loop (only when a reasoning service is mounted) -
    // Registered only if `ctx.subagents` or `ctx.llm` actually exists. A host
    // with neither keeps exactly the v1 surface — including the tool count, so
    // the "activate registers three tools" contract still holds.
    const reasonerStatus = reasoner.describe()
    if (wantedNames.length > 1 && reasonerStatus.available) {
      extensionDefinitions.push(defineTool({
        name: `adjudicate_${slug(pack.id)}_review`,
        description: [
          `${label} — P4 有界推理回路：对工作单的每一捆跑一次有界评审。`,
          `当前执行模式 ${reasonerStatus.mode}${reasonerStatus.degraded ? '（降级）' : ''}。`,
          '预算内运行、可被取消；预算耗尽时未启动的批次会记入报告而不是被静默丢弃。',
        ].join(' '),
        parameters: params({
          target: { type: 'string', description: '被审对象的一句话描述' },
          candidates: { type: 'array', description: '候选集', items: { type: 'object', additionalProperties: true } },
          input: { type: 'object', description: '文档化输入（与 candidates 二选一）：{ format, payload }', additionalProperties: true },
        }),
        output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
        async execute(args, exec) {
          const plan = planFor(pack, { target: args.target, candidates: args.candidates, input: args.input })
          const outcome = await reasoner.run({
            pack,
            target: args.target ?? null,
            bundles: plan.bundles,
            signal: exec?.signal,
            parent: exec?.agent,
            outputSchema: FINDINGS_SCHEMA,
            toolFilter: evidenceToolFilter(pack),
            maxDepth: options.reasoner.maxDepth,
            getBudget: () => ledger,
            onCharge: (entry) => { ledger = charge(ledger, entry) },
          })
          return {
            domain: pack.id,
            target: args.target ?? null,
            lossOrientation: plan.lossOrientation,
            candidateSet: plan.candidateSet,
            bundles: plan.bundles.length,
            ...outcome,
            summary: [
              `# ${pack.title} — P4 有界评审回路`,
              `模式：${outcome.mode}${outcome.degraded ? '（降级）' : ''}　可用：${outcome.available}`,
              `轮次：${outcome.rounds}　发现：${outcome.findings.length}${outcome.skipped.length > 0 ? `　跳过：${outcome.skipped.length}` : ''}`,
              outcome.reason ? `说明：${outcome.reason}` : '',
              outcome.errors.length > 0
                ? `⚠️ 失败批次：\n${outcome.errors.map((error) => `- ${error.bundle ?? '(bundle)'} — ${error.code}: ${error.detail ?? ''}`).join('\n')}`
                : '',
              outcome.available
                ? '把 findings 交回 adjudication_submit 做 P6/P7 独立复核与覆盖度证明。'
                : '本宿主没有注入 ctx.subagents / ctx.llm：请调用方自行完成 P4 回路，或把 findings 直接交给 adjudication_submit。',
            ].filter(Boolean).join('\n'),
          }
        },
      }))
    }

    // Keep only the names the caller asked for, preserving declaration order.
    // Extension-point tools (evidence, P4) are additions on top of the declared
    // domain toolset, so they are appended after the filter — `wantedNames`
    // alone would filter them straight back out.
    return [
      ...definitions.filter((definition) => wantedNames.includes(definition.name)),
      ...extensionDefinitions,
    ]
  }

  // --- P5: anchors are RECOMPUTED, never taken on trust ---------------------

  /**
   * Recompute one finding's anchor.
   *
   * CHANGED (t17) — this function is the fix for F3. Before it, both
   * `adjudication_anchor` and `adjudication_submit` bypassed the domain entirely:
   *
   *   adjudication_anchor   called the engine's generic `resolveAnchor` directly
   *   adjudication_submit   believed `finding.anchored` and `finding.start`
   *
   * The consequence was that a domain's `anchorVerifier` — one of the five
   * extension points every v2 pack must ship — was never executed in production.
   * The whole promise of P5 ("the engine can independently recompute an anchor")
   * was therefore unbacked, and the coverage proof was a caller's self-report:
   * t5 measured a finding with a nonexistent path and `start: 999` scoring
   * coverageRate 1.0 with `complete: true`.
   *
   * The order is deliberate: the DOMAIN verifier runs first when the pack
   * declares one; the engine's generic three-tier ladder is only a fallback for
   * packs that have not migrated yet. The verdict reports which path ran, and a
   * verifier that throws is NOT swallowed — a broken verifier is a contract
   * violation, not an unanchored finding, and hiding it would recreate exactly
   * the silent bypass this closes.
   */
  function recomputeAnchor(pack, finding, documents, candidates) {
    const path = typeof finding?.path === 'string' && finding.path !== '' ? finding.path : null
    const excerpt = typeof finding?.excerpt === 'string' && finding.excerpt !== ''
      ? finding.excerpt
      : (typeof finding?.evidence === 'string' && finding.evidence !== '' ? finding.evidence : null)
    const start = Number.isInteger(finding?.start) ? finding.start : undefined
    const end = Number.isInteger(finding?.end) ? finding.end : undefined

    // CHANGED (t17, second pass): the caller's `locator` is passed through
    // VERBATIM. It is a domain-defined, opaque value — `ANCHOR_CLAIM.required`
    // lists `locator` as required and `lib/contracts.js` declares nineteen
    // different shapes for it (`{clauseId, surfaceId}`, `{nodeId, table, column}`,
    // `{taskId, from, to}`, …). The engine has no standing to rebuild a shape it
    // does not understand, and the first version of this function did exactly
    // that: it constructed `{start, startLine, end, endLine}` and dropped
    // everything else, so sixteen of the nineteen domains would have reached
    // their own verifier with an empty claim and scored zero coverage forever.
    //
    // F3's security property is NOT "the engine reconstructs the locator". It is
    // "the verdict comes from the domain verifier and a verifier that throws is
    // never swallowed". Passing the claim through untouched is what makes the
    // verifier the thing that decides.
    //
    // The top-level `start`/`end` convenience fields are folded in ONLY when the
    // caller supplied no locator at all. That keeps the line-number family
    // (`code-review` reads `locator.startLine`) byte-for-byte identical to the
    // pre-F3 behaviour, while never injecting engine-invented keys into a
    // domain-shaped locator — which would defeat a verifier's own "empty claim"
    // detection.
    const passedLocator = finding?.locator !== null && typeof finding?.locator === 'object'
      ? { ...finding.locator }
      : {}
    const locator = passedLocator
    if (Object.keys(locator).length === 0) {
      if (start !== undefined) { locator.start = start; locator.startLine = start }
      if (end !== undefined) { locator.end = end; locator.endLine = end }
    }
    // CHANGED (t37): a caller-supplied `kind` WINS over the pack's declaration.
    //
    // Before this, `kind` was always `pack.anchorVerifier?.kind ?? pack.anchor?.kind`
    // and `adjudication_anchor`'s documented `kind` parameter was never read — the
    // declaration said "省略则取该领域声明的 anchor kind" (i.e. it is used when
    // supplied) while the behaviour ignored it entirely. Two consequences:
    //
    //   1. a caller could not assert a claim's kind at all, so a claim whose kind
    //      was wrong was silently re-labelled as the pack's kind and then judged
    //      against payload it was never about;
    //   2. every domain's `kind-mismatch` negative case was reproducible ONLY by
    //      calling `verify` directly — through the tool the claim always carried
    //      the pack's kind, so the verifier's kind check could never fire and the
    //      verdict differed from the direct call (`no-documents` instead of
    //      `kind-mismatch`). That was the one remaining fold-path difference in
    //      the whole program (t24-F5), and it is now gone.
    //
    // `null`/absent still means "use the domain's declared kind", so
    // `adjudication_submit` (whose findings carry no kind) is unchanged.
    const declaredKind = pack.anchorVerifier?.kind ?? pack.anchor?.kind ?? null
    const kind = typeof finding?.kind === 'string' && finding.kind !== '' ? finding.kind : declaredKind
    const claim = { kind, path, locator, ...(excerpt === null ? {} : { excerpt }) }
    const verifier = pack.anchorVerifier

    if (verifier !== null && verifier !== undefined && typeof verifier.verify === 'function') {
      const document = path === null ? undefined : documents.find((doc) => doc.path === path)
      // CHANGED (t21): `subject.candidates` is part of the subject the contract
      // declares (§1.2) and is now actually supplied whenever the engine knows
      // it — i.e. after a plan for this domain. It is passed through UNTOUCHED
      // and is omitted entirely when unknown, because a verifier distinguishes
      // "no candidate set was offered" (skip the binding check) from "an empty
      // one was offered" (nothing is bound to anything). Deciding which of the
      // two it is looking at is the domain's call, not the engine's.
      const candidateSet = Array.isArray(candidates) ? candidates : null
      const subject = {
        path,
        content: document?.content,
        document,
        documents,
        ...(candidateSet === null ? {} : { candidates: candidateSet }),
      }
      let verdict
      try {
        verdict = verifier.verify(claim, subject, { domain: pack.id, target: finding?.id ?? null })
      } catch (error) {
        const wrapped = new Error(
          `领域 "${pack.id}" 的 anchorVerifier 在核验发现 "${finding?.id ?? '(无 id)'}" 时抛出：`
          + `${error?.message ?? String(error)} —— 这是验证器契约违规，不当作「未锚定」吞掉`,
        )
        wrapped.code = error?.code ?? ERROR_CODES.E_ANCHOR_CONTRACT
        wrapped.cause = error
        throw wrapped
      }
      const problems = validateAnchorVerdict(verdict)
      if (problems.length > 0) {
        return {
          claim,
          via: 'anchorVerifier',
          verdict: {
            status: 'unanchored',
            tier: 'invalid-verdict',
            path: null,
            start: null,
            end: null,
            detail: `领域验证器返回的裁决不符合锚点契约：${problems.join('; ')}`,
          },
        }
      }
      return { claim, via: 'anchorVerifier', verdict }
    }

    if (excerpt === null) {
      return {
        claim,
        via: 'engine-resolveAnchor',
        verdict: validatedEngineVerdict({
          status: 'unanchored',
          tier: 'no-excerpt',
          path: null,
          start: null,
          end: null,
          detail: '发现没有提供逐字原文（excerpt 或 evidence），引擎无法重算锚点 —— 自报的行号不采信',
        }),
      }
    }
    return {
      claim,
      via: 'engine-resolveAnchor',
      // The ladder validates its own verdicts (`validatedEngineVerdict` inside
      // `resolveAnchor`, t49), so this call needs no second pass; the
      // `no-excerpt` outcome above is built here and is validated here.
      verdict: resolveAnchor(excerpt, documents, path ?? undefined),
    }
  }

  // t49: the engine's own verdicts are validated by the layer that produces them
  // — `lib/engine.js:validatedEngineVerdict`, applied inside `resolveAnchor` and
  // here for the `no-excerpt` outcome. The domain-verifier path above gets the
  // identical treatment via `validateAnchorVerdict` (an `invalid-verdict`
  // downgrade), so no path in this file can hand a caller a tier the vocabulary
  // does not name. Vocabulary: `lib/contracts.js` (`ANCHOR_TIERS`); the
  // two-directional check that keeps it honest: `lib/kernel-test.mjs` §16.

  /** Normalise model-supplied documents once, for every P5 entry point. */
  function anchorDocuments(input) {
    return toDocuments(input)
  }

  // --- P0–P3: the work order ------------------------------------------------

  /**
   * P0 — where the candidate set comes from.
   *
   * Two documented paths, and the distinction is reported either way:
   *   • `candidates` — the caller enumerated them (v1 behaviour, unchanged);
   *   • `input`      — the domain's `candidateSource` enumerates them from the
   *                    domain's documented input format (contract v2).
   * A domain that has not implemented `source.js` gets a loud, actionable error
   * rather than an empty work order that looks like "nothing to review".
   */
  function resolveCandidates(pack, { candidates, input }) {
    if (input === undefined || input === null) {
      return {
        items: candidates,
        source: {
          origin: 'caller-supplied',
          kind: pack.candidateSet?.kind ?? null,
          inputFormat: pack.candidateSet?.inputFormat ?? null,
          bounded: pack.candidateSet?.bounded ?? null,
          truncated: false,
          notes: [],
          excluded: [],
          problems: [],
        },
      }
    }

    const source = pack.candidateSource
    if (source === null || typeof source?.enumerate !== 'function') {
      throw new Error(
        `领域 "${pack.id}" 没有 candidateSource（P0 枚举器），无法接受 input 入参。`
        + ` 改用 candidates 手工喂候选集，或先实现 domains/${pack.id}/source.js。`,
      )
    }
    const declaredFormat = source.inputFormat ?? pack.candidateSet?.inputFormat ?? null
    const format = input.format ?? declaredFormat
    if (declaredFormat !== null && format !== declaredFormat) {
      throw new Error(`input.format "${String(format)}" 与领域 "${pack.id}" 的文档化输入格式 "${declaredFormat}" 不符`)
    }
    if (input.payload === undefined || input.payload === null || typeof input.payload !== 'object') {
      throw contractError(ERROR_CODES.E_INPUT_FORMAT, `input.payload 必须是 ${String(declaredFormat)} 的对象`)
    }

    const limits = { maxCandidates: options.gate.maxCandidates, maxExcerptLines: options.budget.maxExcerptLines }
    const enumerated = source.enumerate(input.payload, {
      ...limits,
      include: pack.gate?.include ?? [],
      exclude: pack.gate?.exclude ?? [],
      extensions: pack.gate?.extensions ?? null,
    }) ?? {}
    const problems = validateCandidateSetResult(enumerated, limits)
    return {
      items: enumerated.candidates ?? [],
      source: {
        origin: 'candidateSource',
        kind: source.kind ?? pack.candidateSet?.kind ?? null,
        inputFormat: declaredFormat,
        bounded: source.bounded !== false,
        truncated: enumerated.truncated === true,
        notes: enumerated.notes ?? [],
        excluded: enumerated.excluded ?? [],
        problems,
      },
    }
  }

  function planFor(pack, { target, candidates, input }) {
    const resolved = resolveCandidates(pack, { candidates, input })
    // CHANGED (t17): `toCandidates` is the SINGLE normaliser for both paths, and
    // it now PRESERVES every field it does not explicitly default. That matters
    // most for a `candidateSource` result: a graph/clause/flow candidate carries
    // its own `locator` (often `title`/`meta` too), and those are exactly what
    // its `bundleKey.resolve` and gate predicates read. Coercing that output down
    // to a fixed key set stripped them, so every non-file domain silently
    // bundled by path and lost its own grouping. Regression: kernel-test
    // "P0 passthrough: a candidate keeps the fields its bundleKey and gate read".
    const items = markSecrets(toCandidates(resolved.items))
    const gateResult = gate(items, {
      ...options.gate,
      include: pack.gate?.include,
      exclude: pack.gate?.exclude,
      extensions: pack.gate?.extensions ?? null,
    })

    const capped = gateResult.selected.slice(0, options.gate.maxCandidates)
    const truncated = gateResult.selected.length - capped.length

    // CHANGED (t17): the engine's OWN admission count is remembered, so the
    // coverage denominator at submit time has a trustworthy source instead of
    // being whatever the caller typed.
    plannedAdmissions.set(pack.id, { admitted: capped.length, target: target ?? null })

    // CHANGED (t21): and the admitted candidates themselves are remembered, so
    // the verifier is handed the locator space the contract promises it. Kept as
    // a shallow copy of the array — the entries are the domain's own objects and
    // are never touched again.
    planCandidates.set(pack.id, capped.slice())

    // P2 — `pack.bundleKey` becomes a real grouping decision HERE. `bundle()`
    // itself is untouched: it already groups by `entry.key`, and the missing
    // half was always the caller's, which never derived that key. Candidates
    // that carry their own key keep it; everything else is derived.
    const bundleKeySettings = options.bundleKey ?? {}
    let bundleKeyInfo = null
    const keyed = capped.map((entry) => {
      const resolution = resolveBundleKey(pack, entry, bundleKeySettings)
      if (bundleKeyInfo === null) {
        bundleKeyInfo = {
          declared: pack.bundleKey ?? null,
          strategy: resolution.strategy,
          applied: resolution.applied,
          source: resolution.source,
          reason: resolution.reason,
          derived: 0,
        }
      }
      if (resolution.applied) {
        bundleKeyInfo.derived += 1
        return { ...entry, key: resolution.key }
      }
      return entry
    })
    if (bundleKeyInfo === null) {
      bundleKeyInfo = {
        declared: pack.bundleKey ?? null, strategy: null, applied: false, source: 'fallback',
        reason: '没有准入候选，未派生 bundle key', derived: 0,
      }
    }

    const bundleResult = bundle(keyed, { ...options.bundle, ...(pack.bundle ?? {}) })

    const bundlesWithRules = bundleResult.bundles.map((item) => {
      const paths = item.entries.map((entry) => entry.path)
      const { injected, unmapped } = selectRules(rulesOf(pack), paths)
      return {
        key: item.key,
        paths,
        rules: injected.map((rule) => rule.name),
        ruleText: renderRules(injected, paths),
        unmappedPaths: unmapped,
      }
    })

    const orientated = LOSS_ORIENTATIONS.includes(pack.lossOrientation)
      ? pack.lossOrientation
      : options.lossOrientation

    // P6 — the reviewer's shape is now read from the pack instead of being
    // implied by the orientation. It selects the panel's behaviour label and
    // the P6 prompt; it never decides keep/drop (that is `lossOrientation`).
    const criticismKind = CRITICISM_KINDS.includes(pack.criticism?.kind)
      ? pack.criticism.kind
      : (DEFAULT_CRITICISM_KIND[orientated] ?? 'fact-checker')

    const sourceLine = resolved.source.origin === 'candidateSource'
      ? `${resolved.source.kind}（格式 ${resolved.source.inputFormat}，${resolved.source.bounded ? '可确定性枚举' : '种子输入，P0 枚举无上界'}）`
      : `调用方提供（candidates 入参，声明 kind=${resolved.source.kind ?? '(未声明)'}）`

    const summary = [
      `# ${pack.title} — 工作单 (P0–P3)`,
      '',
      `对象：${target ?? '(未指定)'}`,
      `损失取向：${orientated}　复核者：${criticismKind === 'triage' ? 'triage 分级筛选' : 'fact-checker 事实核查'}`,
      `锚点：${pack.anchor?.kind ?? '(未定义)'}`,
      '',
      `## 候选集（P0）`,
      `来源：${sourceLine}`,
      `产出 ${resolved.items.length} 项${resolved.source.truncated ? '（已截断）' : ''}`
        + `${resolved.source.excluded.length > 0 ? `，源头排除 ${resolved.source.excluded.length} 项` : ''}`,
      resolved.source.problems.length > 0
        ? `⚠️ candidateSource 的产出不符合契约：${resolved.source.problems.join('; ')}`
        : '',
      ...resolved.source.notes.map((note) => `· ${note}`),
      '',
      `## 闸门`,
      `准入 ${capped.length} 项${truncated > 0 ? `（另有 ${truncated} 项因超出 maxCandidates 被截断）` : ''}`,
      `排除 ${gateResult.excluded.length} 项`,
      gateResult.excluded.length === 0
        ? ''
        : bullet(gateResult.excluded.slice(0, 20).map((item) => `${item.path} — ${item.reason}`)),
      '',
      `## 分捆（${bundleResult.strategy}${bundleResult.degraded ? '，已降级' : ''}）`,
      `bundleKey：${bundleKeyInfo.strategy ?? '(未声明)'} — `
        + (bundleKeyInfo.applied ? `已生效，派生 ${bundleKeyInfo.derived}/${capped.length} 项` : `未生效（${bundleKeyInfo.reason}）`),
      bundleResult.bundles.length === 0
        ? '空：闸门后无候选。这本身就是结论——不要凭空审核。'
        : bullet(bundlesWithRules.map((item) => `${item.key}：${item.paths.length} 项，注入规则 [${item.rules.join(', ') || '无'}]`)),
      '',
      `## 边界`,
      `工具调用预算 ${ledger.settings.maxToolCalls} 次；单次读取上限 ${ledger.settings.maxExcerptLines} 行；检索上限 ${ledger.settings.maxSearchHits} 条。`,
      '',
      `## 下一步`,
      `逐捆在有界范围内判定，每条发现给出锚点（${pack.anchor?.kind}），然后调用 adjudication_submit 交回，由 P6/P7 独立复核并出具覆盖度证明。`,
    ].filter((line) => line !== '').join('\n')

    return {
      domain: pack.id,
      title: pack.title,
      target: target ?? null,
      lossOrientation: orientated,
      anchor: pack.anchor ?? null,
      prompt: pack.prompt ?? null,
      // Contract v2 observability: the candidate set's provenance, the bundle
      // key's fate, and the reviewer shape are all reported, not implied.
      candidateSet: {
        kind: resolved.source.kind,
        inputFormat: resolved.source.inputFormat,
        origin: resolved.source.origin,
        bounded: resolved.source.bounded,
        truncated: resolved.source.truncated,
        notes: resolved.source.notes,
        excludedBySource: resolved.source.excluded,
        problems: resolved.source.problems,
      },
      bundleKey: bundleKeyInfo,
      criticism: { kind: criticismKind, description: pack.criticism?.description ?? null },
      gate: { admitted: capped.length, excluded: gateResult.excluded, truncated, order: gateResult.ordered },
      bundles: bundlesWithRules,
      strategy: bundleResult.strategy,
      degraded: bundleResult.degraded,
      summary,
    }
  }

  // --- always-on core tools -------------------------------------------------
  const coreDisposer = ctx.effect(function* registerCoreTools() {
    yield ctx.tools.register(defineTool({
      name: 'adjudication_domains',
      description: [
        '列出或检索本插件内置的审定领域包（domain pack）。',
        '领域包默认**未激活**：只有激活后，该领域自己的 adjudicate_<领域>_* 工具才会出现。',
        '每个领域声明了候选集形态、闸门、锚点种类与损失取向；A 审定型可直接套用，B 构建型多一个生成器，C 探索型无法承诺有界成本，D 关系型跑在锚点链建出的图上。',
      ].join(' '),
      parameters: params({
        category: { type: 'string', enum: ['A', 'B', 'C', 'D'], description: '按家族过滤：A 审定型 / B 构建型 / C 探索型 / D 关系型' },
        query: { type: 'string', description: '按 id、标题、摘要或关键词检索' },
        active: { type: 'boolean', description: '只列出已激活的领域' },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        const directory = await ensureDirectoryDomains()
        let packs = registry.overview({ category: args.category, query: args.query })
        if (args.active === true) packs = packs.filter((pack) => activated.has(pack.id))

        const grouped = new Map()
        for (const pack of packs) {
          if (!grouped.has(pack.category)) grouped.set(pack.category, [])
          grouped.get(pack.category).push(pack)
        }

        const sections = []
        for (const [key, family] of Object.entries(DOMAIN_CATEGORIES)) {
          const members = grouped.get(key)
          if (members === undefined || members.length === 0) continue
          sections.push(`## ${family.title}`)
          sections.push(`_${family.note}_`)
          sections.push('')
          for (const pack of members) {
            const mark = activated.has(pack.id) ? ' ●' : ''
            sections.push(`- **${pack.id}**${mark} — ${pack.title}　[${pack.lossOrientation}］ 锚点 ${pack.anchorKind}　规则 ${pack.rules} 条${pack.status !== 'ready' ? `　(${pack.status})` : ''}`)
            if (pack.summary) sections.push(`  ${pack.summary}`)
          }
          sections.push('')
        }

        if (sections.length === 0) {
          sections.push('没有匹配的领域包。用 adjudication_domains 不带参数看全部。')
        }
        sections.push(`已激活：${activated.size === 0 ? '（无）' : [...activated.keys()].join(', ')}`)
        sections.push('')
        sections.push('用 adjudication_activate({ domain }) 激活某个领域后，它的专属工具才会注册进来。')
        if (directory !== null && directory !== undefined) {
          sections.push('')
          sections.push('## 领域目录（contract v2）')
          sections.push(describeDomainDirectory(directory))
        }

        return {
          count: packs.length,
          active: [...activated.keys()],
          domains: packs,
          directory: directory === null || directory === undefined ? null : {
            root: directory.root,
            loaded: (directory.loaded ?? []).map((entry) => entry.id),
            added: directory.added ?? [],
            replaced: directory.replaced ?? [],
            skipped: directory.skipped ?? [],
            problems: directory.problems ?? [],
          },
          summary: [`# 审定领域包（共 ${registry.size()} 个，当前列出 ${packs.length} 个）`, '', ...sections].join('\n'),
        }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'adjudication_activate',
      description: [
        '按需激活一个领域包：把该领域自己的工具注册进当前会话，之后就能调用 adjudicate_<领域>_* 。',
        '这是本插件控制上下文成本的方式——领域工具不预先声明，用到哪个装哪个。',
        'depth=entry 只装领域入口工具；depth=full（默认）装入口 + plan + rules 三个。',
      ].join(' '),
      parameters: params({
        domain: { type: 'string', required: true, description: '领域 id，例如 code-review、risk-compliance、ux-review' },
        depth: { type: 'string', enum: ['entry', 'full'], description: '装载深度，默认 full' },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        await ensureDirectoryDomains()
        const depth = args.depth === 'entry' ? 'entry' : (options.domainTools === 'entry' ? 'entry' : 'full')
        const result = activate(args.domain, depth)
        if (!result.ok) {
          return { ok: false, domain: args.domain, summary: `激活失败：${result.reason}` }
        }
        return {
          ok: true,
          domain: result.domain,
          alreadyActive: result.alreadyActive,
          tools: result.tools,
          summary: result.alreadyActive
            ? `领域 ${result.domain} 已经是激活状态，工具：${result.tools.join(', ')}`
            : `已激活领域 ${result.domain}，注册工具：${result.tools.join(', ')}\n下一轮起这些工具可直接调用。不用时用 adjudication_deactivate 卸载，避免占用上下文。`,
        }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'adjudication_deactivate',
      description: '卸载一个已激活领域包，注销它的全部工具。领域做完就该卸载，否则这些工具的模式会一直占着上下文。',
      parameters: params({
        domain: { type: 'string', required: true, description: '要卸载的领域 id' },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        const result = deactivate(args.domain)
        return {
          ...result,
          summary: result.changed
            ? `已卸载领域 ${args.domain}，注销工具：${(result.tools ?? []).join(', ') || '（无）'}`
            : `领域 ${args.domain} 当前未激活，无需卸载。`,
        }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'adjudication_plan',
      description: [
        '跑 P0–P3，为任意已登记领域产出有界审定工作单：闸门准入/排除明细、分捆结果、逐捆注入的规则、以及预算边界。',
        '这是确定性阶段，不调用模型：同样的候选集与规则库必然得到同样的工作单。',
        '排除项会给出**原因**，因为"为什么没审"和"审出了什么"同等重要。',
      ].join(' '),
      parameters: params({
        domain: { type: 'string', required: true, description: '领域 id' },
        target: { type: 'string', description: '被审对象的一句话描述' },
        candidates: {
          type: 'array',
          description: '候选集：每项 { path, bytes?, additions?, deletions?, deleted?, binary?, key? }',
          items: { type: 'object', additionalProperties: true },
        },
        input: {
          type: 'object',
          description: '文档化输入（与 candidates 二选一）：{ format, payload }。仅在领域实现了 candidateSource 时可用。',
          additionalProperties: true,
        },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        await ensureDirectoryDomains()
        const pack = registry.get(args.domain)
        if (pack === undefined) {
          throw new Error(`unknown domain "${args.domain}" — call adjudication_domains to list the registry`)
        }
        return planFor(pack, { target: args.target, candidates: args.candidates, input: args.input })
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'adjudication_anchor',
      description: [
        'P5 锚点解析：把模型抄写的原文片段确定性地定位到具体文档与行号。',
        '**优先调用该领域的 anchorVerifier**（声明了的话）；领域未迁移时回退引擎通用三级阶梯。返回里的 `via` 会标明实际走的是哪条路径。',
        '三级降级：① 在指名的文档里用滑窗找；② 跨文档搬到**唯一**命中的那一处；③ 无命中则返回未锚定。',
        '跨文档命中不唯一时**拒绝猜测**，返回 ambiguousIn。未锚定的发现应在交回时标记降级，而不是当成已确认。',
        '这是整套机制的地基：锚点必须能被引擎独立重算，模型说的行号一概不采信。',
      ].join(' '),
      parameters: params({
        excerpt: { type: 'string', required: true, description: '逐字抄写的原文片段（多行即可，缩进不必精确）' },
        path: { type: 'string', description: '模型声称该片段所在的文档路径' },
        documents: {
          type: 'array',
          required: true,
          description: '候选文档：每项 { path, content }',
          items: { type: 'object', additionalProperties: true },
        },
        domain: { type: 'string', description: '用哪个领域的 anchorVerifier 来核验；省略则一律走引擎通用阶梯' },
        kind: { type: 'string', description: '锚点种类。**传入时按传入的 kind 核验**（与领域声明的 kind 不同则会得到 kind-mismatch 的未锚定裁决）；省略则取该领域声明的 anchor kind' },
        locator: {
          type: 'object',
          additionalProperties: true,
          description: '领域自定义的定位器（如 {clauseId,surfaceId} / {taskId,from,to}），原样透传给 anchorVerifier',
        },
        candidates: {
          type: 'array',
          description: 'P0 候选集（可选）：领域验证器重算「结构侧」锚点时的材料。省略时若该领域已有过 plan，则用那次准入的候选集',
          items: { type: 'object', additionalProperties: true },
        },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        const documents = anchorDocuments(args.documents)
        const domainId = typeof args.domain === 'string' && args.domain !== '' ? args.domain : null
        let pack = null
        if (domainId !== null) {
          await ensureDirectoryDomains()
          pack = registry.get(domainId)
          if (pack === undefined) {
            throw new Error(`unknown domain "${domainId}" — call adjudication_domains to list the registry`)
          }
        }

        // CHANGED (t17): a declared domain verifier runs FIRST. Calling the
        // generic engine ladder while ignoring `pack.anchorVerifier` is what let
        // a throwing verifier pass silently — the domain was never consulted.
        if (pack?.anchorVerifier !== undefined && pack?.anchorVerifier !== null
          && typeof pack.anchorVerifier.verify === 'function') {
          const finding = { path: args.path, excerpt: args.excerpt, locator: args.locator, start: undefined, kind: args.kind }
          // CHANGED (t21): the caller may hand the candidate set over explicitly;
          // otherwise the last plan for this domain supplies it. Both are the
          // domain's own objects, passed through untouched.
          const candidateSet = Array.isArray(args.candidates)
            ? args.candidates
            : planCandidates.get(pack.id)
          const { claim, verdict } = recomputeAnchor(pack, { ...finding, id: '(adjudication_anchor)' }, documents, candidateSet)
          const summary = verdict.status === 'anchored'
            ? `已锚定：${verdict.path}:${verdict.start}-${verdict.end}（${verdict.tier}，经 ${pack.id} 的 anchorVerifier）`
            : [
              `未锚定（${verdict.tier}，经 ${pack.id} 的 anchorVerifier）`,
              verdict.detail ?? '',
              verdict.ambiguousIn ? `候选位置不唯一，出现在：${verdict.ambiguousIn.join(', ')}` : '',
              '该发现必须标记为未锚定并降级，不得当作已确认。',
            ].filter(Boolean).join('\n')
          return { ...verdict, via: 'anchorVerifier', domain: pack.id, claim, summary }
        }

        const result = resolveAnchor(args.excerpt, documents, args.path)
        const summary = result.status === 'anchored'
          ? `已锚定：${result.path}:${result.start}-${result.end}（${result.tier}，经引擎通用阶梯）`
          : [
            `未锚定（${result.tier}，经引擎通用阶梯）`,
            result.ambiguousIn ? `候选位置不唯一，出现在：${result.ambiguousIn.join(', ')}` : '',
            domainId === null
              ? '提示：指定 domain 可改用该领域自己的 anchorVerifier（v2 领域包应声明它）。'
              : `领域 "${domainId}" 尚未声明 anchorVerifier，已回退引擎通用阶梯。`,
            '匹配是逐字的：只忽略缩进与 diff 标记，标点必须一致。最常见的原因是转述而非抄写 —— 请原样复制该行（含分号、括号、引号）。',
            '该发现必须标记为未锚定并降级，不得当作已确认。',
          ].filter(Boolean).join('\n')
        return { ...result, via: 'engine-resolveAnchor', domain: domainId, summary }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'adjudication_submit',
      description: [
        '交回判定结果，跑 P6–P7：对每条发现应用本领域的损失取向做独立复核，计算覆盖度证明，出具报告。',
        '**锚点由引擎重算，不采信发现自报的 `anchored`/`start`**：每条发现都会用该领域的 anchorVerifier（未声明时回退引擎通用阶梯）对着 `documents` 重新核验，重算不成立即判未锚定并给出理由。',
        '所以请把发现所引用的文档原文一并放进 `documents`，否则引擎无法重算，该发现只能被判未锚定。',
        'precision-first 领域只保留证据能证明的；recall-first 领域只删除被证据正面否定的。',
        'security/privacy/safety/data-loss/legal 等受保护主题在两种取向下都**先于正确性判断**被保留。',
        '未锚定的发现会被单独计入 unanchored，不算作有效发现——覆盖率按已锚定的不同路径数计算，且分母不小于引擎自己认定过的准入数。',
      ].join(' '),
      parameters: params({
        domain: { type: 'string', required: true, description: '领域 id' },
        target: { type: 'string', description: '被审对象的一句话描述' },
        total: { type: 'integer', description: '闸门准入的候选总数，用于覆盖度分母；不得小于引擎能认定的值' },
        admitted: { type: 'integer', description: '同 total，二者取其一' },
        excluded: { type: 'integer', description: '被闸门排除的数量，仅用于报告' },
        bundles: { type: 'integer', description: '分捆数，仅用于报告' },
        documents: {
          type: 'array',
          description: '重算锚点所需的文档原文：每项 { path, content }。缺少它时引擎无法重算，发现会被判未锚定。',
          items: { type: 'object', additionalProperties: true },
        },
        findings: {
          type: 'array',
          required: true,
          description: '发现列表：每项 { id, path?, excerpt?, start?, end?, severity, subject?, message, evidence, defended?, disproved? }；start/anchored 仅供参考，引擎一律重算',
          items: { type: 'object', additionalProperties: true },
        },
        candidates: {
          type: 'array',
          description: 'P0 候选集（可选）：领域验证器重算「结构侧」锚点时的材料。省略时用该领域上次 plan 准入的候选集',
          items: { type: 'object', additionalProperties: true },
        },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args, exec) {
        await ensureDirectoryDomains()
        const pack = registry.get(args.domain)
        if (pack === undefined) {
          throw new Error(`unknown domain "${args.domain}" — call adjudication_domains to list the registry`)
        }

        const findings = Array.isArray(args.findings) ? args.findings : []
        const documents = anchorDocuments(args.documents)

        // CHANGED (t17): every finding's anchor is RECOMPUTED here. `anchored`
        // and `start` as supplied by the caller are ignored outright — that is
        // the whole point. A finding the engine cannot re-derive is unanchored,
        // whatever the caller said about it.
        //
        // CHANGED (t21): the subject also carries `subject.candidates` — the
        // candidate set the last `adjudication_plan` for this domain admitted.
        // Without it, a verifier whose structural half lives in the enumerated
        // locator space (clause/surface bindings, branch/step membership,
        // layer/prop/token triples, module edges) could never anchor anything
        // through this tool, while its unit tests — which call `verify` with a
        // hand-built subject — stayed green. The contract declared the field all
        // along (docs/domain-contract-v2.md §1.2).
        const candidateSet = Array.isArray(args.candidates) ? args.candidates : planCandidates.get(pack.id)
        const verified = findings.map((finding) => {
          const { claim, via, verdict } = recomputeAnchor(pack, finding, documents, candidateSet)
          return { finding, claim, via, verdict }
        })
        const anchoredFindings = verified
          .filter((item) => item.verdict.status === 'anchored')
          .map((item) => ({
            ...item.finding,
            // The RECOMPUTED location wins, including a relocation.
            path: item.verdict.path,
            start: item.verdict.start,
            end: item.verdict.end,
            anchored: true,
            anchorTier: item.verdict.tier,
            anchorVia: item.via,
            // The domain's own "where" — shown for the ID/graph families, whose
            // anchored verdicts carry no line number.
            anchorLocator: item.verdict.locator ?? item.claim.locator,
            // CHANGED (t41): the domain's own verdict METADATA now travels too,
            // from an explicit whitelist — see `P6_VERDICT_FIELDS`. Without this
            // the P6 prompt's attribution line could never see a basis, no matter
            // how many renderers were wired up downstream.
            ...Object.fromEntries(P6_VERDICT_FIELDS
              .filter((key) => item.verdict[key] !== undefined && item.verdict[key] !== null)
              .map((key) => [key, item.verdict[key]])),
          }))
        const rejected = verified.filter((item) => item.verdict.status !== 'anchored')
        const unanchored = rejected.length

        // CHANGED (t41): P6 now RUNS. The domain's `reviewPrompts.verify` is
        // rendered and executed over the anchored findings — before this, the
        // only thing called "P6" at runtime was `runCritiquePanel` below, which
        // is a deterministic loss policy that never reads a prompt.
        //
        // Order matters and is deliberate:
        //   1. anchoring first (a finding that could not be recomputed is not a
        //      finding anybody should be re-checking);
        //   2. the independent re-check over the ANCHORED set;
        //   3. the loss policy, which keeps the keep/drop authority.
        // P6's verdicts are REPORTED, not applied: `lossOrientation` +
        // protected subjects stay the thing that decides admissibility
        // (`lib/engine.js:critique`), so this does not put the same knob on the
        // dial twice. What changed is that the domain's own reviewer is now
        // consulted on the real path instead of existing only as delivered text.
        const verifyOutcome = await reasoner.runVerify({
          pack,
          target: args.target ?? null,
          findings: anchoredFindings,
          signal: exec?.signal,
          parent: exec?.agent,
          outputSchema: VERIFY_SCHEMA,
          toolFilter: verifyToolFilter(),
          maxDepth: options.reasoner.maxDepth,
          getBudget: () => ledger,
          onCharge: (entry) => { ledger = charge(ledger, entry) },
        })

        const critiqueResult = runCritiquePanel(anchoredFindings, {
          orientation: pack.lossOrientation ?? options.lossOrientation,
          // Contract v2: the pack's declared reviewer shape is READ here. It
          // labels the panel; the P6 PROMPT is selected by the pack's
          // `reviewPrompts.verify`, which `runVerify` above now renders. The kind
          // itself never decides keep/drop, which stays with `lossOrientation`.
          kind: pack.criticism?.kind,
          protectedSubjects: pack.protectedSubjects,
        })

        // CHANGED (t17): the denominator is no longer whatever the caller typed.
        // It is floored by (a) the count the ENGINE admitted during planning and
        // (b) the number of findings it could actually anchor. A caller cannot
        // shrink the denominator to inflate the rate.
        const declared = typeof args.total === 'number'
          ? args.total
          : (typeof args.admitted === 'number' ? args.admitted : null)
        const planned = plannedAdmissions.get(pack.id)
        let total = declared ?? 0
        let totalSource = declared === null ? 'anchored-count' : 'caller'
        const planApplies = planned !== undefined
          && (declared === null || planned.target === (args.target ?? null))
        if (planApplies && planned.admitted > total) {
          total = planned.admitted
          totalSource = 'plan'
        }
        if (anchoredFindings.length > total) {
          total = anchoredFindings.length
          totalSource = 'anchored-count'
        }

        const coverageProof = coverage(total, critiqueResult.kept, {
          requireComplete: pack.lossOrientation === 'recall-first',
        })
        coverageProof.totalSource = totalSource
        coverageProof.declaredTotal = declared
        coverageProof.raisedAboveDeclared = declared !== null && total > declared

        ledger = charge(ledger, { toolCalls: 1, text: JSON.stringify(findings).slice(0, 2000) })

        const result = report({
          domain: pack,
          target: args.target ?? null,
          scope: { admitted: total, excluded: args.excluded ?? 0, bundles: args.bundles ?? 0 },
          findings: critiqueResult.kept,
          coverageProof,
          budget: { toolCalls: ledger.toolCalls, tokens: ledger.tokens, note: ledger.note },
          critiqueResult,
        })

        const bySeverity = new Map()
        for (const finding of critiqueResult.kept) {
          const key = finding.severity ?? 'unspecified'
          bySeverity.set(key, (bySeverity.get(key) ?? 0) + 1)
        }

        const verificationLine = pack.anchorVerifier === undefined || pack.anchorVerifier === null
          ? '锚点重算：引擎通用阶梯（本领域尚未声明 anchorVerifier）'
          : `锚点重算：${pack.id} 的 anchorVerifier（kind=${pack.anchorVerifier.kind ?? pack.anchor?.kind ?? '(未声明)'}）`

        const summary = [
          `# ${pack.title} — 判定报告`,
          '',
          `对象：${args.target ?? '(未指定)'}`,
          `损失取向：${critiqueResult.orientation}　复核者：${critiqueResult.kind === 'triage' ? 'triage 分级筛选（只看正面否定）' : 'fact-checker 事实核查（只看证据能否证明）'}`,
          verificationLine,
          '',
          `## 结果`,
          `提交 ${findings.length} 条，引擎重算后已锚定 ${anchoredFindings.length} 条，未锚定 ${unanchored} 条（自报的 anchored/start 一律不采信）。`,
          `复核保留 ${critiqueResult.kept.length} 条，丢弃 ${critiqueResult.dropped.length} 条，受保护主题否决 ${critiqueResult.vetoes} 条。`,
          bySeverity.size === 0 ? '' : `按严重度：${[...bySeverity].map(([key, count]) => `${key} ${count}`).join('，')}`,
          '',
          // CHANGED (t41): the independent re-check is now a stage that RUNS, so
          // the report says whether it ran, which prompt source it used, and what
          // it said. "Not run" is stated with its reason — never silently absent,
          // because an absent P6 line reads exactly like a P6 that passed.
          //
          // CHANGED (t46): "ran, and its answer could not be parsed" is now a
          // THIRD state, rendered in its own words. Before this it printed
          // 「裁决 0 条」 — byte-identical to a reviewer that honestly said it had
          // nothing to overturn, which folded "the reviewer answered the wrong
          // question" into "nothing was rejected".
          `## P6 独立复核`,
          `模式：${verifyOutcome.mode}${verifyOutcome.degraded ? '（降级）' : ''}　提示词来源：${verifyOutcome.prompt?.source ?? '(none)'}　轮次：${verifyOutcome.rounds}`,
          // CHANGED (t49): "the P6 text IS the P4 text" is a FOURTH state, with
          // its own words. It cannot borrow 「未执行」: that is what a host with no
          // reasoning service reports, and equating "the domain shipped no
          // independent re-check" with "this host has no model" would hide a
          // domain-package defect inside an environment fact.
          verifyOutcome.code === REASONER_CODES.E_P6_NOT_INDEPENDENT
            ? `**P6 未启动：本领域的 P6 提示词与 P4 提示词逐字相同**（${verifyOutcome.code}）—— 独立复核会变成同一位评审者用同样的话再问一遍，`
              + '所以引擎没有启动它（`reviewPrompts.verify` 必须与 `reviewPrompts.review` 说不同的话）。'
              + `${verifyOutcome.errors?.[0]?.detail ?? verifyOutcome.reason ?? '(无细节)'}。`
              + '这是领域包的问题，不是本轮的结论：P6 的裁决不改变准入（见上一行的保留/丢弃数）。'
            : verifyOutcome.code === REASONER_CODES.E_VERDICT_UNPARSED
              ? `**未得到裁决：复核者的答复无法解析**（${verifyOutcome.code}）—— 这**不是**「没有要推翻的」：`
                + `${verifyOutcome.errors?.[0]?.detail ?? verifyOutcome.reason ?? '(无细节)'}。`
                + 'P6 的裁决不改变准入：准入由损失取向与受保护主题决定（见上一行的保留/丢弃数）。'
              : (verifyOutcome.ran
                ? `裁决 ${verifyOutcome.verdicts.length} 条`
                  + (verifyOutcome.verdicts.filter((entry) => entry.keep === false).length > 0
                    ? `，其中 ${verifyOutcome.verdicts.filter((entry) => entry.keep === false).length} 条复核判不通过`
                    : '')
                  + '。P6 的裁决不改变准入：准入由损失取向与受保护主题决定（见上一行的保留/丢弃数）。'
                : `未执行：${verifyOutcome.reason ?? '(无原因)'}。`),
          verifyOutcome.available ? '' : '本宿主没有注入 ctx.subagents / ctx.llm：P6 只能由调用方 agent 自行完成。',
          '',
          `## 覆盖度`,
          `准入 ${coverageProof.total} 项（分母来源：${totalSource}${coverageProof.raisedAboveDeclared ? `，已高于调用方声明的 ${declared}` : ''}），`
            + `已审定 ${coverageProof.reviewed} 项，覆盖率 ${(coverageProof.coverageRate * 100).toFixed(1)}%${coverageProof.complete ? '' : ' — **不完整**'}。`,
          coverageProof.required && !coverageProof.complete
            ? '本领域是 recall-first，覆盖率不完整即为未通过：请补齐未覆盖部分，或明确说明为何无法覆盖。'
            : '',
          unanchored > 0
            ? `\n⚠️ ${unanchored} 条发现未能通过引擎重算，已排除在有效发现之外。未锚定的结论不可作为结论使用：\n`
              + bullet(rejected.slice(0, 10).map((item) => `${item.finding?.id ?? '(无 id)'} — ${item.verdict.tier}: ${item.verdict.detail ?? ''}`))
            : '',
          '',
          critiqueResult.dropped.length > 0
            ? `## 被丢弃\n${bullet(critiqueResult.dropped.map((item) => `${item.id ?? '(无 id)'} — ${item.reason}`))}`
            : '',
          '',
          `预算：已用工具调用 ${ledger.toolCalls}/${ledger.settings.maxToolCalls}（${ledger.note}）。`,
        ].filter((line) => line !== '').join('\n')

        // Hand the machine-readable report back through tool content.
        return {
          ...result,
          unanchored,
          unanchoredDetails: rejected.map((item) => ({
            id: item.finding?.id ?? null,
            tier: item.verdict.tier,
            via: item.via,
            detail: item.verdict.detail ?? null,
          })),
          anchorVia: pack.anchorVerifier === undefined || pack.anchorVerifier === null ? 'engine-resolveAnchor' : 'anchorVerifier',
          // CHANGED (t41): the machine-readable P6 outcome, so a caller can assert
          // the independent re-check ran instead of parsing the summary text.
          review: {
            kind: critiqueResult.kind,
            orientation: critiqueResult.orientation,
            verify: verifyOutcome,
          },
          summary,
        }
      },
    }))
  }, 'adjudication.coreTools()')

  // --- optional system-prompt section --------------------------------------
  // Deliberately terse: discovery of the six core tools is worth a few lines,
  // but a section that enumerates nineteen domains would defeat the entire
  // on-demand design.
  if (options.promptSection !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.effect(() => promptCtx.systemPrompt.section({
        name: 'plugin:adjudication',
        order: options.promptSectionOrder,
        text: () => {
          const packs = registry.list()
          const families = Object.keys(DOMAIN_CATEGORIES)
            .map((key) => {
              const members = packs.filter((pack) => pack.category === key)
              return members.length === 0 ? null : `${key} ${members.length}`
            })
            .filter(Boolean)
            .join(' / ')
          const recallFirst = packs.filter((pack) => pack.lossOrientation === 'recall-first').map((pack) => pack.id)
          return [
            `## 审定引擎 (adjudication)`,
            `可用领域包 ${packs.length} 个（${families}），**默认全部未加载**。`,
            `- \`adjudication_domains\` — 检索领域包（先查再选，不要凭印象假设某个领域存在）`,
            `- \`adjudication_activate\` — 按需装载某领域的专属工具；装载后才能调用 \`adjudicate_<领域>_*\``,
            `- \`adjudication_deactivate\` — 用完卸载，避免工具模式长期占用上下文`,
            `- \`adjudication_plan\` — 确定性产出有界工作单（闸门/分捆/规则/预算）`,
            `- \`adjudication_anchor\` — 把抄写的原文定位到确定的行；行号一律不采信`,
            `- \`adjudication_submit\` — 交回判定，独立复核并出覆盖度证明`,
            recallFirst.length === 0 ? '' : `recall-first 领域（漏检代价更高）：${recallFirst.join(', ')}`,
          ].filter(Boolean).join('\n')
        },
      }), 'adjudication.promptSection()')
    })
  }

  // --- teardown -------------------------------------------------------------
  ctx.effect(() => () => {
    for (const dispose of activated.values()) {
      try {
        dispose()
      } catch {
        // Never let one broken disposer strand the rest.
      }
    }
    activated.clear()
    activatedTools.clear()
    coreDisposer?.()
    if (sharedRegistry === registry) sharedRegistry = null
    if (sharedFacade === facade) sharedFacade = null
  }, 'adjudication.dispose()')

  facade.publishedAs = publishedAs
}

/** Re-exported so consumers and tests can reach the data and the engine. */
export { BUILTIN_DOMAINS, CORE_TOOL_NAMES, createRegistry, DOMAIN_CATEGORIES }
export {
  bundle,
  coverage,
  createBudget,
  gate,
  resolveAnchor,
  runCritiquePanel,
  selectRules,
} from './lib/engine.js'
