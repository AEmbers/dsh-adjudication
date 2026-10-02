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
// ---------------------------------------------------------------------------
// Request-shaped domain routing (ADDED: request-router)
//
// WHY: `search` used to be a single substring test — `haystack.includes(query)`.
// That works for `"operator-design"` or `"算子"`, and returns NOTHING for the
// shape a user actually types:
//
//     "算子的数值容差改了，前端渲染也跟着动了，测试覆盖没补，文档也没更新"   → 0 packs
//
// The failure is silent (an empty list looks like "no such domain"), and it
// lands hardest on the case that matters most: one piece of work that spans
// several domains, where the user cannot name any of them. So matching is now
// scored, in BOTH directions, and the query is decomposed before comparison:
//
//   * `id` / `title` mentioned verbatim in the request;
//   * curated `keywords` mentioned verbatim (latin works today and keeps working);
//   * request fragments found inside a field — for CJK, 2- and 3-grams of the
//     request, with fragment-grammar stop characters dropped, so
//     "算子的数值容差改了" yields 算子 / 数值 / 容差 / 数值容 / 值容差 and scores
//     `operator-design`, while "测试覆盖没补" scores `tech-test` and
//     "文档也没更新" scores `tech-doc`. One sentence, several domains — which is
//     the whole point.
//
// Every hit carries its `reasons` so the caller can see WHY a pack was selected
// instead of being handed an unexplained shortlist.
// ---------------------------------------------------------------------------
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/gu
const CJK_STOP_CHARS = new Set(
  '的了和与及或也还就都而但把被给对从到在是有没不个这那些啥吗呢吧啊呀嘛我你他她它地得着过很太更最再又只把让使'.split(''),
)
const LATIN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to',
  'was', 'were', 'will', 'with', 'not', 'no', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
])

/** Lowercase, and never `undefined`. */
function searchLower(value) {
  return String(value ?? '').toLowerCase()
}

/** Decompose a free-form request into matchable fragments (latin tokens + CJK n-grams). */
function requestFragments(query) {
  const found = new Set()
  for (const token of searchLower(query).split(/[^\p{L}\p{N}+#._-]+/u)) {
    const trimmed = token.trim()
    if (trimmed === '') continue
    if (trimmed.length >= 2 && !LATIN_STOPWORDS.has(trimmed)) found.add(trimmed)
    for (const run of trimmed.match(CJK_RUN) ?? []) {
      for (let size = 2; size <= 3; size += 1) {
        for (let i = 0; i + size <= run.length; i += 1) {
          const fragment = run.slice(i, i + size)
          if ([...fragment].some((ch) => CJK_STOP_CHARS.has(ch))) continue
          found.add(fragment)
        }
      }
    }
  }
  return [...found]
}

/** Where a fragment matched, and how much that field is worth. */
const MATCH_FIELDS = [
  { key: 'id', weight: 8, label: 'id' },
  { key: 'title', weight: 6, label: '标题' },
  { key: 'keywords', weight: 5, label: '关键词' },
  { key: 'anchorKind', weight: 3, label: '锚点' },
  { key: 'extensions', weight: 3, label: '扩展名' },
  { key: 'summary', weight: 2, label: '摘要' },
]

function packSearchFields(pack) {
  return {
    id: searchLower(pack?.id),
    title: searchLower(pack?.title),
    keywords: (pack?.keywords ?? []).map(searchLower).join(' '),
    summary: searchLower(pack?.summary),
    anchorKind: searchLower(pack?.anchor?.kind),
    extensions: (pack?.gate?.extensions ?? []).map(searchLower).join(' '),
  }
}

/** Score one pack against a request. Returns `{ score, reasons }`. */
function scorePackAgainst(pack, query, fragments) {
  const fields = packSearchFields(pack)
  const raw = searchLower(query)
  let score = 0
  const reasons = []
  const add = (weight, reason) => {
    score += weight
    if (reasons.length < 3 && !reasons.includes(reason)) reasons.push(reason)
  }

  // Whole-field mentions in the raw request: keeps `"operator-design"` and
  // `"算子设计"` behaving exactly as they did before.
  if (fields.id !== '' && raw.includes(fields.id)) add(20, `id 命中 ${pack.id}`)
  if (fields.title !== '' && raw.includes(fields.title)) add(16, `标题命中 ${pack.title}`)
  for (const keyword of (pack?.keywords ?? []).map(searchLower)) {
    if (keyword.length >= 2 && raw.includes(keyword)) add(6, `关键词命中 ${keyword}`)
  }

  // Fragment containment, weighted by which field carries it. At most one field
  // claims a fragment, so a long summary cannot pile up points.
  for (const fragment of fragments) {
    for (const field of MATCH_FIELDS) {
      if (fields[field.key].includes(fragment)) {
        add(field.weight, `${field.label}含「${fragment}」`)
        break
      }
    }
  }

  return { score, reasons }
}

/**
 * Rank packs against a free-form request. Empty query → every pack, score 0.
 * Returns `[{ pack, score, reasons }]`, highest score first, ties by id.
 */
function rankPacks(packs, query) {
  const raw = String(query ?? '').trim()
  if (raw === '') return packs.map((pack) => ({ pack, score: 0, reasons: [] }))
  const fragments = requestFragments(raw)
  return packs
    .map((pack) => ({ pack, ...scorePackAgainst(pack, raw, fragments) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || searchLower(a.pack.id).localeCompare(searchLower(b.pack.id)))
}

/**
 * Create an in-memory registry of domain packs.
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

    /**
     * Search packs for a free-form request (CHANGED: request-router). A whole
     * sentence now matches every domain it touches, ranked best-first; use
     * {@link rank} when you also want the reasons.
     */
    search(query) {
      return rankPacks([...domains.values()], query).map((hit) => hit.pack)
    },

    /**
     * Same as {@link search} but keeps `{score, reasons}` per hit, so a caller
     * can explain WHY a domain was selected rather than handing over an
     * unexplained shortlist. Empty query → every pack at score 0.
     */
    rank(query) {
      return rankPacks([...domains.values()], query)
    },

    size() {
      return domains.size
    },

    /** Observe registration changes. Returns an unsubscribe function. */
    observe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * A compact, model-facing view of every pack (never the full rule text).
     *
     * CHANGED (request-router): when a `query` is given the result is ranked and
     * each entry carries `match: {score, reasons}`, so the caller can justify the
     * shortlist. Without a query the shape is exactly what it always was.
     */
    overview(filter = {}) {
      const describe = (pack) => ({
        id: pack.id,
        title: pack.title,
        category: pack.category,
        lossOrientation: pack.lossOrientation,
        anchorKind: pack.anchor?.kind ?? null,
        summary: pack.summary ?? '',
        rules: rulesOf(pack).length,
        status: pack.status ?? 'ready',
      })
      if (filter.category) return this.byCategory(filter.category).map(describe)
      if (String(filter.query ?? '').trim() === '') return this.list().map(describe)
      return this.rank(filter.query).map((hit) => ({
        ...describe(hit.pack),
        match: { score: hit.score, reasons: hit.reasons },
      }))
    },
  }
}
