/**
 * D-family shared graph utilities — `domains/_lib/graph.js`.
 *
 * WHY A SHARED FILE EXISTS UNDER `domains/`
 * -----------------------------------------
 * `domains/_lib/` is ignored by `lib/domain-loader.js` (`IGNORED_DIRECTORY_NAMES`
 * covers `_`-prefixed names and `discoverDomains` skips them before it even looks
 * for an `index.js`), so nothing here is a domain and nothing here is loaded as
 * one. It is scratch space three sibling domains may import from.
 *
 * The three D domains (project-management, user-feedback, requirement-alignment)
 * adjudicate the SAME kind of object: a directed graph whose vertices are
 * identifiers. Their products are not "something is wrong here" but "the
 * relationship between these two things is wrong". That shared subject is what
 * is factored out here:
 *
 *   • typed document normalisation      (`documentsOf`, `graphDocuments`)
 *   • identifier-space integrity        (`duplicateIds`, `nodesWith`,
 *                                        `duplicateNodeIds`, `allNodeIds`)
 *   • the ordered adjacency structure    (`adjacency`)
 *   • the anchor vocabulary              (`locate`, `confirmed`, `stale`, …)
 *   • relocation across graph documents  (`relocate`)
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Each domain's `anchor.js` OWNS its claim vocabulary, its tier ladder and its
 * decision of what counts as proof. Nothing in this file decides whether a claim
 * is true — it only reports graph facts. A domain that disagreed with a helper's
 * finding could not express that disagreement through these functions, which is
 * exactly why none of them return an AnchorVerdict.
 *
 * ZERO IMPORTS. Every anchor in these three domains is a pair of identifiers, so
 * there is no text matching here and therefore no upstream (open-code-review)
 * lineage to attribute: this file is original to dsh-adjudication.
 */

// ---------------------------------------------------------------------------
// Text and path helpers
// ---------------------------------------------------------------------------

/** UTF-8 byte length, without touching `Buffer`. */
export function byteLength(value) {
  return new TextEncoder().encode(String(value)).length
}

/** `estimateDays` -> `estimate-days`. Used to name rules after their field. */
export function camelToKebab(value) {
  return String(value ?? '').replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()
}

/** Normalise a path for comparison: backslashes to slashes, no trailing slash. */
export function slash(value) {
  return String(value ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '')
}

/** The leading `depth` path segments. `a/b/c.json` at depth 1 is `a`. */
export function directoryOf(path, depth = 1) {
  const parts = slash(path).split('/')
  parts.pop()
  if (parts.length === 0) return '.'
  const wanted = Math.max(1, Math.min(Number(depth) || 1, parts.length))
  return parts.slice(0, wanted).join('/')
}

/** Cut `text` to at most `maxLines` lines, reporting whether anything was lost. */
export function clipLines(text, maxLines) {
  const lines = String(text ?? '').split(/\r?\n/u)
  if (lines.length <= maxLines) return { text: String(text ?? ''), truncated: false, lines: lines.length }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true, lines: lines.length }
}

/** Deterministic JSON — key order is sorted so a key derived from it is stable. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** `1 项` / `2 项` — the count line every tool's provenance uses. */
export function countOf(items) {
  return Array.isArray(items) ? items.length : 0
}

// ---------------------------------------------------------------------------
// Candidate paths a tracker export can actually produce
// ---------------------------------------------------------------------------

/**
 * THE ONE CONSTRAINT THAT SHAPES EVERY PATH IN THIS FAMILY
 * -------------------------------------------------------
 * `validateCandidateSetResult` requires `candidate.path` to match
 * `^[a-z0-9][a-z0-9._:\/-]*$` — no `>`, no uppercase, no spaces — and the P1
 * gate's extension predicate takes `path.slice(path.lastIndexOf('.'))`, so any
 * dot after the extension turns the candidate's type into garbage. Meanwhile
 * `lib/engine.js`'s gate reports exclusions as `{ path, predicate }` only, so two
 * candidates sharing one path are indistinguishable in `plan.gate.excluded`, and
 * `coverage()` counts DISTINCT PATHS, so a shared path merges two items into one
 * denominator slot.
 *
 * Together those four facts leave exactly one workable scheme:
 *
 *     <document stem> '-' <semantic token> '.json'
 *     project/cart-checkout/plan-t1-t2.json     the edge T1 → T2
 *     project/cart-checkout/plan-task-t1.json   the node T1
 *
 * The stem keeps the real document's directory (so P2 grouping and P3 rule globs
 * still see a truthful path), the token makes every candidate unique, and the
 * extension stays exactly one dot long and last. The raw ids — `T1`, `T1->T2`,
 * `2024-Q3` — live in `locator` and in `text`, never in `path`.
 *
 * A slug is lossy, so it is never trusted back: `slugOf` is exported so a
 * verifier can derive the expected token and ignore a caller's `#fragment` when it
 * matches. Nothing downstream ever parses a task id out of a path.
 */
export function kebabSlug(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  return slug === '' ? 'x' : slug
}

/** Cap a path segment's length; the tail of a long id is not worth a broken path. */
export function capSegment(value, max = 96) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return text.slice(0, max).replace(/-[^-]*$/u, '')
}

/**
 * `project/cart/plan.json` -> `project/cart/plan`. Any extension is dropped.
 *
 * The comparison is case-insensitive on purpose: a plan shipped as `.JSON` is a
 * plan, and a candidate path that kept the capitalised extension would be dropped
 * by the gate's `path.slice(path.lastIndexOf('.')).toLowerCase()` predicate for no
 * reason anyone could see.
 */
export function stemOf(documentPath) {
  const text = slash(documentPath)
  const at = text.lastIndexOf('/')
  const head = at < 0 ? '' : text.slice(0, at + 1)
  const tail = at < 0 ? text : text.slice(at + 1)
  const dot = tail.lastIndexOf('.')
  const stem = dot <= 0 ? tail : tail.slice(0, dot)
  return `${head}${stem === '' ? 'graph' : stem}`
}

/**
 * The extension of `documentPath`, lower-cased, or `'.json'` when it has none.
 *
 * Preserving the source document's extension is what keeps the P1 gate HONEST for
 * a graph domain: if the gate rejects `.txt`, then a plan that arrived as `.txt`
 * must produce `.txt` candidates, or the unsupported document would be silently
 * re-typed into a supported one and sail through the gate it was supposed to fail.
 */
export function extensionOf(documentPath) {
  const lowered = slash(documentPath).toLowerCase()
  const at = lowered.lastIndexOf('/')
  const tail = at < 0 ? lowered : lowered.slice(at + 1)
  const dot = tail.lastIndexOf('.')
  return dot <= 0 ? '.json' : tail.slice(dot)
}

/** `<document stem>-<token><document extension>` — the candidate path scheme. */
export function derivedPath(documentPath, token, extension = extensionOf(documentPath)) {
  return capSegment(`${stemOf(documentPath)}-${kebabSlug(token)}`) + extension
}

/**
 * The token a `derivedPath` used for `value`. Used by verifiers to decide whether
 * a caller's `#fragment` is merely the slug of the id they also passed in the
 * locator — in which case the locator, not the fragment, is the claim.
 */
export function tokenOf(value) {
  return kebabSlug(value)
}

// ---------------------------------------------------------------------------
// Typed documents
// ---------------------------------------------------------------------------

/**
 * Pull the graph payload out of a document, accepting three spellings.
 *
 *   { payload: {...} }   the domain's own shape (`source.js` consumes this)
 *   { graph: {...} }     a caller's synonym
 *   { content: '<json>' } the ENGINE's shape
 *
 * The third one matters and is not a convenience. `toDocuments` in `index.js`
 * normalises every P5 document to `{ path, content }` because that is the right
 * shape for a TEXT anchor — and a graph anchor is not a text anchor. Rather than
 * asking the engine to learn one domain's payload shape, this domain reads it out
 * of the text: a task graph is a documented JSON input format, and JSON in a
 * string is the same graph. That keeps the engine's document contract intact and
 * keeps the anchor `engine-recomputable` — the verifier re-derives the graph from
 * the material it was handed rather than trusting a pre-digested object.
 *
 * A `content` that is not a JSON object is ignored, so prose documents (which many
 * other domains use) pass through this module untouched.
 */
function payloadOf(entry) {
  for (const key of ['payload', 'graph', 'task_graph']) {
    const value = entry[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  }
  const text = typeof entry.content === 'string' ? entry.content : (typeof entry.text === 'string' ? entry.text : '')
  const trimmed = text.trim()
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Normalise one caller-supplied document.
 *
 * A document is a GRAPH DOCUMENT: a path, a type, an opaque payload, and an
 * optional `meta` carrying the facts the P1 gate reads (`bytes`, `binary`,
 * `deleted`). The payload is never interpreted here; each domain names it.
 *
 * @returns {{ path: string, type: string, payload: object, meta: object }|null}
 */
export function normalizeDocument(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const path = slash(entry.path ?? '')
  if (path === '') return null
  const payload = payloadOf(entry)
  if (payload === null) return null
  return {
    path,
    type: typeof entry.type === 'string' && entry.type !== '' ? entry.type : 'unknown',
    payload,
    meta: entry.meta !== null && typeof entry.meta === 'object' ? entry.meta : {},
  }
}

/** Normalise a document array, dropping (never guessing at) malformed entries. */
export function documentsOf(list) {
  if (!Array.isArray(list)) return []
  return list.map(normalizeDocument).filter((entry) => entry !== null)
}

/** Payload keys a graph-bearing document may be spelled with. */
export const GRAPH_KEYS = Object.freeze([
  'tasks', 'feedback', 'decisions', 'items', 'nodes', 'edges', 'graph', 'trace', 'links',
  'owners', 'leases', 'teams', 'clusters', 'themes', 'idSpace', 'idSpaces', 'index',
])

/** Does this payload carry any graph-bearing key at all? */
export function looksLikeGraph(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  return GRAPH_KEYS.some((key) => Object.hasOwn(payload, key))
}

/**
 * The subset of documents the subject declares this claim is about.
 *
 * `subject.types` narrows it by document type (`['trace-graph']`). Two deliberate
 * leniencies, both load-bearing:
 *
 *   • A document whose type is `'unknown'` is KEPT. The engine's `toDocuments`
 *     normalises away `type`, and dropping those would make every claim arriving
 *     through `adjudication_submit` see zero documents — i.e. the filter would
 *     silently delete the whole integration path. An untyped document is not a
 *     wrong-typed one.
 *   • `subject.path` is NOT used to narrow. It names the document the claim was
 *     made against, and the verifier needs the OTHER documents present to be able
 *     to refuse an ambiguous relocation. Dropping them here would convert
 *     "ambiguous" into "unique", the single most dangerous simplification in this
 *     file.
 */
export function graphDocuments(subject) {
  const documents = documentsOf(subject?.documents)
  const types = Array.isArray(subject?.types) ? subject.types.map(String) : null
  if (types === null || types.length === 0) return documents
  return documents.filter((document) => document.type === 'unknown' || types.includes(document.type))
}

/** The document whose path equals `path`, or null. */
export function documentByPath(documents, path) {
  const wanted = slash(path ?? '')
  if (wanted === '') return null
  return documents.find((document) => document.path === wanted) ?? null
}

// ---------------------------------------------------------------------------
// Identifier-space integrity
// ---------------------------------------------------------------------------

/**
 * Identifiers that appear more than once.
 *
 * Returned as a sorted array rather than a map because its only use is refusal:
 * a graph that cannot tell two things with the same id apart cannot be used to
 * confirm anything about either of them, and the verifier says so by listing
 * exactly which ids made it unusable.
 */
export function duplicateIds(values) {
  const seen = new Map()
  for (const value of values ?? []) {
    const key = String(value ?? '')
    if (key === '') continue
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort()
}

/** Every `id` of every item of `list`, in order. */
export function idsOf(list) {
  return (Array.isArray(list) ? list : []).map((item) => String(item?.id ?? '')).filter((id) => id !== '')
}

/** Ids appearing twice in one list. */
export function idsDuplicatedIn(list) {
  return duplicateIds(idsOf(list))
}

/**
 * Call one accessor over every document and collect the results.
 * A thin helper purely so the three domains' `anchor.js` files read as prose.
 */
export function collect(documents, accessor) {
  const out = []
  for (const document of documents ?? []) {
    const value = accessor(document)
    if (value === undefined || value === null) continue
    out.push(value)
  }
  return out
}

// ---------------------------------------------------------------------------
// Adjacency — the ordered structure the whole family queries
// ---------------------------------------------------------------------------

/**
 * Pairs as `[from, to]` strings, in declaration order, per document.
 *
 * `edgePairs(document, options)` is supplied by the caller because the three
 * domains spell their edges differently: `dependsOn` is a list on the source
 * node, `links` is a list of `{from, to}`, and a trace graph is the same list
 * with a `kind` attached. Normalising all three here would mean this file had to
 * know all three payload shapes, and then a fourth domain would edit it.
 *
 * @param {object[]} documents
 * @param {(document: object) => Array<[string, string]>} edgePairs
 * @returns {Map<string, { from: string, to: string, out: string[], in: string[] }>}
 */
export function adjacency(documents, edgePairs) {
  const nodes = new Map()
  const touch = (id) => {
    const key = String(id ?? '')
    if (key === '') return null
    if (!nodes.has(key)) nodes.set(key, { from: null, to: null, out: [], in: [] })
    return nodes.get(key)
  }
  for (const document of documents ?? []) {
    for (const pair of edgePairs(document) ?? []) {
      const from = String(pair?.[0] ?? '')
      const to = String(pair?.[1] ?? '')
      if (from === '' || to === '') continue
      const entry = touch(from)
      touch(to)
      if (entry !== null) {
        if (entry.from === null) entry.from = from
        entry.out.push(to)
      }
      const target = nodes.get(to)
      if (target !== null && target !== undefined) {
        if (target.to === null) target.to = to
        target.in.push(from)
      }
    }
  }
  return nodes
}

/** A task/node with no incoming and no outgoing edge — the orphan shape. */
export function isOrphan(node) {
  if (node === null || node === undefined) return false
  return node.out.length === 0 && node.in.length === 0
}

/**
 * Reachability from `start` over `edges`, depth-first, bounded by `maxDepth`
 * and `maxVisits`. Returns the node list in visit order.
 *
 * Bounded for the same reason every evidence tool is: an unbounded walk over a
 * caller-supplied graph is a denial-of-service the caller can trigger by
 * accident. The bound is reported, never silently applied.
 */
export function reachableFrom(start, edges, { maxDepth = 6, maxVisits = 200 } = {}) {
  const out = new Map()
  for (const [from, to] of edges ?? []) {
    const key = String(from)
    if (!out.has(key)) out.set(key, [])
    out.get(key).push(String(to))
  }
  const visited = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (depth > maxDepth || visited.length >= maxVisits) return
    for (const next of out.get(String(node)) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      visited.push(next)
      walk(next, depth + 1)
    }
  }
  walk(start, 1)
  return { visited, bounded: maxDepth, limit: maxVisits }
}

// ---------------------------------------------------------------------------
// The anchor vocabulary
// ---------------------------------------------------------------------------

/**
 * The shape every verifier in this family returns.
 *
 * ANCHOR VOCABULARY REUSE (read this before changing a field)
 * ----------------------------------------------------------
 * `lib/contracts.js` `validateAnchorVerdict` requires an anchored verdict to
 * carry a 1-based integer `start` and an `end >= start`. For a text anchor that
 * is a line span. For a graph anchor there are no lines, and the contract
 * provides no second vocabulary — so the span is REUSED to mean "the position of
 * the verified item within the verified document", with `position` naming what
 * that position indexes (an edge ordinal, a hop ordinal, a ledger row). A
 * reporting consumer must not print `start` as a line number for these three
 * domains; `position` is the field that says what it is.
 *
 * That overload is a real wart. It is documented here, asserted in each domain's
 * `test.mjs` (which checks every anchored verdict carries a `position`), and it
 * is the smallest deviation that keeps the shared verdict type rather than
 * inventing a parallel one the engine would not validate.
 */
export function anchored({ path, start, end, position, tier, detail, claim, nodes, extra = {} }) {
  return {
    status: 'anchored',
    tier,
    path,
    start,
    end,
    position: position ?? null,
    claim: claim ?? null,
    ...(nodes === undefined ? {} : { nodes }),
    detail: detail ?? null,
    ...extra,
  }
}

/**
 * An unanchored verdict. `tier` must be one of the tiers `lib/contracts.js`
 * declares; `relocation-ambiguous` additionally requires `ambiguousIn`.
 */
export function unanchored({ tier, detail, ambiguousIn, claim, extra = {} }) {
  return {
    status: 'unanchored',
    tier,
    path: null,
    start: null,
    end: null,
    position: null,
    claim: claim ?? null,
    detail: detail ?? null,
    ...(ambiguousIn === undefined ? {} : { ambiguousIn }),
    ...extra,
  }
}

/**
 * A graph the claim *could* be about. The claim body is `kind` + `locator`;
 * everything else (`graphPath`, the expected status) is the caller's.
 *
 * @param {string} kind
 * @param {object} locator
 * @param {string} tag a stable, short rendering of the claim body for messages
 * @returns {object}
 */
export function claimBody(kind, locator, tag) {
  return { kind, locator, tag }
}

/** Mutable recorder: every claim body that held in at least one document. */
export function emptyLedger() {
  return { hits: [], seen: 0 }
}

/**
 * The relocation recorder. `record(body, where)` is called once per document a
 * claim body held in; `verdict()` then implements the ladder's third tier:
 *
 *   exactly one document  -> relocated-unique (the caller decides how to report)
 *   two or more documents -> relocation-ambiguous, listing every competitor
 *   none                  -> no-match
 *
 * A "document" here is a whole graph payload. Coarse on purpose: a finding that
 * is true of two different graphs has not been anchored to either of them, and
 * collapsing the two by picking the one with the lower path is the failure mode
 * the whole ladder exists to prevent.
 */
export function relocate() {
  const hits = []
  return {
    record(body, where, extra = {}) {
      hits.push({ body, where, ...extra })
    },
    count() {
      return hits.length
    },
    verdict() {
      if (hits.length === 1) {
        const [only] = hits
        return { kind: 'unique', hit: only }
      }
      if (hits.length > 1) {
        return { kind: 'ambiguous', ambiguousIn: hits.map((hit) => hit.where), hits }
      }
      return { kind: 'none' }
    },
  }
}

/** Sort helper for the deterministic `ambiguousIn` lists the tests pin. */
export function sortedUnique(values) {
  return [...new Set((values ?? []).map(String))].sort()
}

// ---------------------------------------------------------------------------
// Identifier resolution inside one graph document
// ---------------------------------------------------------------------------

/**
 * Does exactly one graph document declare `id`? Returns every declaration, so
 * the caller can both take the unique one and list the competitors.
 *
 * This is the structural answer to "two vertices with the same id". It is the
 * check a graph domain must run BEFORE it confirms any edge, because
 * `duplicateIds` only sees duplicates within one document's own id list — the
 * same task id appearing in a plan document and a risk document is a different
 * (and equally disqualifying) collision.
 *
 * @param {object[]} documents
 * @param {Array<{ nodes: string[]|Record<string,[string,string]> }>} index
 *        one entry per document: the ids it declares, as a list or as a
 *        `{ id: [...] }` map
 */
export function declarationsOf(index, id) {
  const wanted = String(id ?? '')
  const out = []
  if (wanted === '') return out
  for (const entry of index ?? []) {
    const nodes = entry?.nodes
    if (Array.isArray(nodes)) {
      if (nodes.includes(wanted)) out.push(entry)
    } else if (nodes instanceof Set) {
      if (nodes.has(wanted)) out.push(entry)
    } else if (nodes !== null && typeof nodes === 'object' && Object.hasOwn(nodes, wanted)) {
      out.push(entry)
    }
  }
  return out
}

/** `[{path, ids}]` -> `[{path, nodes: Map<id, extra>}]` for `declarationsOf`. */
export function idIndex(entries) {
  return (entries ?? []).map((entry) => ({
    path: entry.path,
    nodes: entry.nodes instanceof Map ? entry.nodes : new Set(entry.nodes ?? []),
    extra: entry.extra ?? null,
  }))
}

/**
 * Every simple path `from -> to` over `edges`, bounded by `maxPaths` and
 * `maxLength`.
 *
 * "Every" is the load-bearing word. A cycle claim is confirmed only when the
 * graph offers exactly ONE route between its first and last node; if two routes
 * exist, the finding's cycle is one of several and the claim has not pinned down
 * which — that is `relocation-ambiguous`, and it is listed rather than collapsed.
 * A bounded search that stopped at the first path would make every ambiguous
 * cycle look unique.
 *
 * @param {string} from
 * @param {string} to
 * @param {Array<[string,string]>} edges
 * @returns {{ paths: string[][], truncated: boolean }}
 */
export function simplePaths(from, to, edges, { maxPaths = 12, maxLength = 12 } = {}) {
  const out = new Map()
  for (const [a, b] of edges ?? []) {
    const key = String(a)
    if (!out.has(key)) out.set(key, [])
    out.get(key).push(String(b))
  }
  const start = String(from)
  const goal = String(to)
  const paths = []
  let truncated = false

  const walk = (node, trail) => {
    if (trail.length > maxLength) { truncated = true; return }
    const nexts = out.get(node) ?? []
    for (const [index, next] of nexts.entries()) {
      if (next === goal) {
        // A self-loop (`from === to`) is the `[start, start]` route. It is a real
        // cycle and must be reported, so the trail is not consulted on this
        // branch: a one-node cycle would otherwise be filtered out as a repeat.
        if (paths.length >= maxPaths) {
          // The cap dropped a route that actually arrived. This is the honest
          // moment to raise the flag.
          truncated = true
          return
        }
        paths.push([...trail, next])
        continue
      }
      if (trail.includes(next)) continue // a cycle on the way; not a simple path
      // A branch that was never explored because the cap was already reached. The
      // flag is raised HERE and nowhere else: raising it merely because
      // `paths.length === maxPaths` would make a graph with exactly one cycle
      // report `truncated: true`, and the caller would then distrust a result that
      // is in fact complete — which is the opposite of what the flag is for.
      if (paths.length >= maxPaths) {
        if (index < nexts.length || (out.get(next)?.length ?? 0) > 0) truncated = true
        continue
      }
      // eslint-disable-next-line no-use-before-define
      walk(next, [...trail, next])
    }
  }
  if (out.get(start)?.includes(goal)) paths.push([start, goal])
  walk(start, [start])

  return { paths, truncated }
}

