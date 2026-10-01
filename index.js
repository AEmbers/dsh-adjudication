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

/** Coerce a model-supplied document array into the engine's shape. */
function toDocuments(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((doc) => doc !== null && typeof doc === 'object' && typeof doc.path === 'string')
    .map((doc) => ({ path: doc.path, content: typeof doc.content === 'string' ? doc.content : '' }))
}

/** Coerce a model-supplied candidate array. */
function toCandidates(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item) => item !== null && typeof item === 'object' && typeof item.path === 'string')
    .map((item) => ({
      path: item.path,
      bytes: typeof item.bytes === 'number' ? item.bytes : undefined,
      additions: typeof item.additions === 'number' ? item.additions : 0,
      deletions: typeof item.deletions === 'number' ? item.deletions : 0,
      binary: item.binary === true,
      deleted: item.deleted === true,
      key: typeof item.key === 'string' ? item.key : undefined,
    }))
}

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
    registerDomain: (pack) => registry.register(pack),
    registerDomains: (packs) => registry.registerAll(packs),
    listDomains: () => registry.list(),
    getDomain: (id) => registry.get(id),
    engine: {
      gate, bundle, selectRules, renderRules, resolveAnchor,
      runCritiquePanel, coverage, report, createBudget, charge,
    },
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
  function activate(domainId, depth) {
    const pack = registry.get(domainId)
    if (pack === undefined) {
      return { ok: false, reason: `unknown domain "${domainId}" — call adjudication_domains to list the registry` }
    }
    const existing = activated.get(domainId)
    if (existing !== undefined) {
      return { ok: true, alreadyActive: true, domain: domainId, tools: activatedTools.get(domainId) ?? [] }
    }

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
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        return planFor(pack, { target: args.target, candidates: args.candidates })
      },
    }))

    if (wantedNames.length > 1) {
      definitions.push(defineTool({
        name: `adjudicate_${slug(pack.id)}_plan`,
        description: `${label} — 只跑 P0–P3：闸门、分捆、规则注入，返回工作单，不含领域角色文本。`,
        parameters: params({
          target: { type: 'string', description: '被审对象的一句话描述' },
          candidates: { type: 'array', description: '候选集', items: { type: 'object', additionalProperties: true } },
        }),
        output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
        async execute(args) {
          return planFor(pack, { target: args.target, candidates: args.candidates })
        },
      }))

      definitions.push(defineTool({
        name: `adjudicate_${slug(pack.id)}_rules`,
        description: `${label} — 列出本领域的规则库（名称、匹配范围、正文）与锚点定义，供人工扩充规则时参考。`,
        parameters: params({}),
        output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
        async execute() {
          const rules = (pack.rules ?? []).map((rule) => ({
            name: rule.name,
            match: Array.isArray(rule.match) ? rule.match : [rule.match],
            text: rule.text,
          }))
          const summary = [
            `# ${label}（${pack.id}）规则库`,
            '',
            `锚点：${pack.anchor?.kind} — ${pack.anchor?.description ?? ''}`,
            `损失取向：${pack.lossOrientation}`,
            `规则条数：${rules.length}（规则库状态：${pack.rulesStatus ?? 'starter'}）`,
            '',
            rules.length === 0
              ? '本领域尚未提供规则。引擎、闸门与锚点均可用，但判定缺少书面依据。'
              : rules.map((rule) => `## ${rule.name}\n匹配：${rule.match.join(', ')}\n\n${rule.text}`).join('\n\n'),
          ].join('\n')
          return { domain: pack.id, rules, summary }
        },
      }))
    }

    // Keep only the names the caller asked for, preserving declaration order.
    return definitions.filter((definition) => wantedNames.includes(definition.name))
  }

  // --- P0–P3: the work order ------------------------------------------------
  function planFor(pack, { target, candidates }) {
    const items = markSecrets(toCandidates(candidates))
    const gateResult = gate(items, {
      ...options.gate,
      include: pack.gate?.include,
      exclude: pack.gate?.exclude,
      extensions: pack.gate?.extensions ?? null,
    })

    const capped = gateResult.selected.slice(0, options.gate.maxCandidates)
    const truncated = gateResult.selected.length - capped.length

    const bundleResult = bundle(capped, { ...options.bundle, ...(pack.bundle ?? {}) })

    const bundlesWithRules = bundleResult.bundles.map((item) => {
      const paths = item.entries.map((entry) => entry.path)
      const { injected, unmapped } = selectRules(pack.rules, paths)
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

    const summary = [
      `# ${pack.title} — 工作单 (P0–P3)`,
      '',
      `对象：${target ?? '(未指定)'}`,
      `损失取向：${orientated}`,
      `锚点：${pack.anchor?.kind ?? '(未定义)'}`,
      '',
      `## 闸门`,
      `准入 ${capped.length} 项${truncated > 0 ? `（另有 ${truncated} 项因超出 maxCandidates 被截断）` : ''}`,
      `排除 ${gateResult.excluded.length} 项`,
      gateResult.excluded.length === 0
        ? ''
        : bullet(gateResult.excluded.slice(0, 20).map((item) => `${item.path} — ${item.reason}`)),
      '',
      `## 分捆（${bundleResult.strategy}${bundleResult.degraded ? '，已降级' : ''}）`,
      bundleResult.bundles.length === 0
        ? '空：闸门后无候选。这本身就是结论——不要凭空审核。'
        : bullet(bundlesWithRules.map((item) => `${item.key}：${item.paths.length} 项，注入规则 [${item.rules.join(', ') || '无'}]`)),
      '',
      `## 边界`,
      `工具调用预算 ${ledger.settings.maxToolCalls} 次；单次读取上限 ${ledger.settings.maxExcerptLines} 行；检索上限 ${ledger.settings.maxSearchHits} 条。`,
      '',
      `## 下一步`,
      `逐捆在有界范围内判定，每条发现给出锚点（${pack.anchor?.kind}），然后调用 adjudication_submit 交回，由 P6/P7 独立复核并出具覆盖度证明。`,
    ].join('\n')

    return {
      domain: pack.id,
      title: pack.title,
      target: target ?? null,
      lossOrientation: orientated,
      anchor: pack.anchor ?? null,
      prompt: pack.prompt ?? null,
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

        return {
          count: packs.length,
          active: [...activated.keys()],
          domains: packs,
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
          required: true,
          description: '候选集：每项 { path, bytes?, additions?, deletions?, deleted?, binary?, key? }',
          items: { type: 'object', additionalProperties: true },
        },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        const pack = registry.get(args.domain)
        if (pack === undefined) {
          throw new Error(`unknown domain "${args.domain}" — call adjudication_domains to list the registry`)
        }
        return planFor(pack, { target: args.target, candidates: args.candidates })
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'adjudication_anchor',
      description: [
        'P5 锚点解析：把模型抄写的原文片段确定性地定位到具体文档与行号。',
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
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        const result = resolveAnchor(args.excerpt, toDocuments(args.documents), args.path)
        const summary = result.status === 'anchored'
          ? `已锚定：${result.path}:${result.start}-${result.end}（${result.tier}）`
          : [
            `未锚定（${result.tier}）`,
            result.ambiguousIn ? `候选位置不唯一，出现在：${result.ambiguousIn.join(', ')}` : '',
            '匹配是逐字的：只忽略缩进与 diff 标记，标点必须一致。最常见的原因是转述而非抄写 —— 请原样复制该行（含分号、括号、引号）。',
            '该发现必须标记为未锚定并降级，不得当作已确认。',
          ].filter(Boolean).join('\n')
        return { ...result, summary }
      },
    }))

    yield ctx.tools.register(defineTool({
      name: 'adjudication_submit',
      description: [
        '交回判定结果，跑 P6–P7：对每条发现应用本领域的损失取向做独立复核，计算覆盖度证明，出具报告。',
        'precision-first 领域只保留证据能证明的；recall-first 领域只删除被证据正面否定的。',
        'security/privacy/safety/data-loss/legal 等受保护主题在两种取向下都**先于正确性判断**被保留。',
        '未锚定的发现会被单独计入 unanchored，不算作有效发现——覆盖率按已锚定的不同路径数计算。',
      ].join(' '),
      parameters: params({
        domain: { type: 'string', required: true, description: '领域 id' },
        target: { type: 'string', description: '被审对象的一句话描述' },
        total: { type: 'integer', description: '闸门准入的候选总数，用于覆盖度分母' },
        admitted: { type: 'integer', description: '同 total，二者取其一' },
        excluded: { type: 'integer', description: '被闸门排除的数量，仅用于报告' },
        bundles: { type: 'integer', description: '分捆数，仅用于报告' },
        findings: {
          type: 'array',
          required: true,
          description: '发现列表：每项 { id, path?, start?, end?, anchored?, severity, subject?, message, evidence, defended?, disproved? }',
          items: { type: 'object', additionalProperties: true },
        },
      }),
      output: { schema: { type: 'object' }, render: (_args, value) => text(value.summary) },
      async execute(args) {
        const pack = registry.get(args.domain)
        if (pack === undefined) {
          throw new Error(`unknown domain "${args.domain}" — call adjudication_domains to list the registry`)
        }

        const findings = Array.isArray(args.findings) ? args.findings : []
        const anchored = findings.filter((finding) => finding?.anchored === true || (typeof finding?.start === 'number' && finding.start > 0))
        const unanchored = findings.length - anchored.length

        const critiqueResult = runCritiquePanel(anchored, {
          orientation: pack.lossOrientation ?? options.lossOrientation,
          protectedSubjects: pack.protectedSubjects,
        })

        const total = typeof args.total === 'number' ? args.total : (typeof args.admitted === 'number' ? args.admitted : anchored.length)
        const coverageProof = coverage(total, critiqueResult.kept, {
          requireComplete: pack.lossOrientation === 'recall-first',
        })

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

        const summary = [
          `# ${pack.title} — 判定报告`,
          '',
          `对象：${args.target ?? '(未指定)'}`,
          `损失取向：${critiqueResult.orientation}`,
          '',
          `## 结果`,
          `提交 ${findings.length} 条，其中已锚定 ${anchored.length} 条，未锚定 ${unanchored} 条。`,
          `复核保留 ${critiqueResult.kept.length} 条，丢弃 ${critiqueResult.dropped.length} 条，受保护主题否决 ${critiqueResult.vetoes} 条。`,
          bySeverity.size === 0 ? '' : `按严重度：${[...bySeverity].map(([key, count]) => `${key} ${count}`).join('，')}`,
          '',
          `## 覆盖度`,
          `准入 ${coverageProof.total} 项，已审定 ${coverageProof.reviewed} 项，覆盖率 ${(coverageProof.coverageRate * 100).toFixed(1)}%${coverageProof.complete ? '' : ' — **不完整**'}。`,
          coverageProof.required && !coverageProof.complete
            ? '本领域是 recall-first，覆盖率不完整即为未通过：请补齐未覆盖部分，或明确说明为何无法覆盖。'
            : '',
          unanchored > 0 ? `\n⚠️ ${unanchored} 条发现未能锚定，已排除在有效发现之外。未锚定的结论不可作为结论使用。` : '',
          '',
          critiqueResult.dropped.length > 0
            ? `## 被丢弃\n${bullet(critiqueResult.dropped.map((item) => `${item.id ?? '(无 id)'} — ${item.reason}`))}`
            : '',
          '',
          `预算：已用工具调用 ${ledger.toolCalls}/${ledger.settings.maxToolCalls}（${ledger.note}）。`,
        ].filter((line) => line !== '').join('\n')

        // Hand the machine-readable report back through tool content.
        return { ...result, unanchored, summary }
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
