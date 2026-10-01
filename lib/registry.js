/**
 * dsh-adjudication — the domain registry.
 *
 * A **domain pack** is a plain data object. It carries every domain-specific
 * decision the engine needs and nothing else: what the candidate set is, which
 * predicates gate it, how it bundles, which rules apply, what an anchor is, and
 * which way the loss must lean. The engine (`lib/engine.js`) is domain-blind.
 *
 * This split is the whole design. Adding a twentieth domain is adding a data
 * object — never touching the engine, never touching the tools, never
 * re-registering a schema the model already learned.
 *
 * Packs can come from three places, in increasing order of decoupling:
 *   1. the built-in library in `lib/domains.js`, selected by `config.domains`
 *   2. a downstream cordis plugin row that does `inject: ['adjudication']`
 *   3. any consumer that imports `createRegistry` and registers its own
 */

// CHANGED (t17): the overview used to read `pack.rules` directly, so a v2
// directory pack — whose rules the loader assembles into `ruleLibrary.rules` —
// was reported as "规则 0 条". The shared accessor is the single answer to
// "which rules does this pack have"; see its contract note in contracts.js.
import { rulesOf } from './contracts.js'

/** The four families every pack belongs to. */
export const DOMAIN_CATEGORIES = {
  A: { id: 'A', title: 'A · 审定型 (review)', note: '候选集可确定性枚举 — open-code-review\'s shape applies directly.' },
  B: { id: 'B', title: 'B · 构建型 (construct)', note: '审定型回路前面加一个受约束的生成器。' },
  C: { id: 'C', title: 'C · 探索型 (explore)', note: 'P0 枚举失效，候选集本身要找 — 不能承诺有界成本。' },
  D: { id: 'D', title: 'D · 关系型 (relate)', note: '产物是一致性本身，跑在锚点链建出的图上。' },
}

/** Loss orientations, re-exported so packs and registry agree. */
export { LOSS_ORIENTATIONS } from './engine.js'

const REQUIRED_FIELDS = ['id', 'title', 'category', 'anchor', 'lossOrientation']

/**
 * Validate one pack. Returns a list of human-readable problems; an empty list
 * means the pack is registrable. Callers decide whether a malformed pack throws
 * (built-in library) or is skipped with a warning (third-party row).
 *
 * @param {object} pack
 * @returns {string[]}
 */
export function validateDomain(pack) {
  const problems = []
  if (pack === null || typeof pack !== 'object') return ['pack is not an object']

  for (const field of REQUIRED_FIELDS) {
    if (pack[field] === undefined || pack[field] === null || pack[field] === '') {
      problems.push(`missing required field "${field}"`)
    }
  }
  if (typeof pack.id === 'string' && !/^[a-z][a-z0-9-]*$/u.test(pack.id)) {
    problems.push(`id "${pack.id}" must be lowercase kebab-case (tool names are derived from it)`)
  }
  if (pack.category !== undefined && !Object.hasOwn(DOMAIN_CATEGORIES, pack.category)) {
    problems.push(`category "${pack.category}" is not one of ${Object.keys(DOMAIN_CATEGORIES).join('/')}`)
  }
  if (pack.lossOrientation !== undefined && pack.lossOrientation !== 'precision-first' && pack.lossOrientation !== 'recall-first') {
    problems.push(`lossOrientation "${pack.lossOrientation}" must be precision-first or recall-first`)
  }
  if (pack.anchor !== undefined && (typeof pack.anchor !== 'object' || typeof pack.anchor.kind !== 'string')) {
    problems.push('anchor must be an object with a "kind" string')
  }
  if (pack.rules !== undefined && !Array.isArray(pack.rules)) {
    problems.push('rules must be an array')
  }
  return problems
}

/** `code-review` -> `code_review`, so a domain id can be a tool name segment. */
export function slug(id) {
  return String(id).replace(/-/gu, '_')
}

/** The tool name a domain's own entry tool gets. */
export function entryToolName(id) {
  return `adjudicate_${slug(id)}`
}

/** The tool names a domain contributes when activated at `'full'` depth. */
export function domainToolNames(id) {
  return [entryToolName(id), `adjudicate_${slug(id)}_plan`, `adjudicate_${slug(id)}_rules`]
}

/**
 * Create a registry. Registration returns a disposer, matching every other
 * registry in the harness, so a pack contributed by a cordis plugin row is
 * automatically withdrawn when that row unloads.
 *
 * @param {object} [options] `{onChange, strict}`
 */
export function createRegistry(options = {}) {
  const domains = new Map()
  const listeners = new Set()
  if (typeof options.onChange === 'function') listeners.add(options.onChange)

  function notify() {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A broken listener must never stop a registration.
      }
    }
  }

  return {
    /** Register a pack. Returns its disposer. Throws on invalid packs when strict. */
    register(pack) {
      const problems = validateDomain(pack)
      if (problems.length > 0) {
        if (options.strict !== false) {
          throw new Error(`invalid domain pack "${pack?.id ?? '(anonymous)'}": ${problems.join('; ')}`)
        }
        return () => {}
      }
      domains.set(pack.id, pack)
      notify()
      return () => {
        domains.delete(pack.id)
        notify()
      }
    },

    /** Bulk-register. Returns one disposer for the whole batch. */
    registerAll(packs) {
      const disposers = (packs ?? []).map((pack) => this.register(pack))
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },

    get(id) {
      return domains.get(id)
    },

    has(id) {
      return domains.has(id)
    },

    list() {
      return [...domains.values()]
    },

    byCategory(category) {
      return [...domains.values()].filter((pack) => pack.category === category)
    },

    search(query) {
      const needle = String(query ?? '').trim().toLowerCase()
      if (needle === '') return this.list()
      return [...domains.values()].filter((pack) => {
        const haystack = [pack.id, pack.title, pack.summary, ...(pack.keywords ?? [])].filter(Boolean).join(' ').toLowerCase()
        return haystack.includes(needle)
      })
    },

    size() {
      return domains.size
    },

    /** Observe registration changes. Returns an unsubscribe function. */
    observe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /** A compact, model-facing view of every pack (never the full rule text). */
    overview(filter = {}) {
      const packs = filter.category ? this.byCategory(filter.category) : this.search(filter.query)
      return packs.map((pack) => ({
        id: pack.id,
        title: pack.title,
        category: pack.category,
        lossOrientation: pack.lossOrientation,
        anchorKind: pack.anchor?.kind ?? null,
        summary: pack.summary ?? '',
        rules: rulesOf(pack).length,
        status: pack.status ?? 'ready',
      }))
    },
  }
}
