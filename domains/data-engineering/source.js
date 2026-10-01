/**
 * data-engineering — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `lineage-and-schema` (see `DOMAIN_INPUT_FORMATS` in
 * `lib/contracts.js`, which is the authority this file follows):
 *
 *   {
 *     nodes: [{
 *       id, type, inputs: string[], outputs: string[],
 *       path?, sql?, schedule?,
 *     }],
 *     schema?: { 'db.table': { columns: [{ name, type, nullable, default? }] } },
 *     runs?:   [{ nodeId, status, at? }],
 *   }
 *
 * THE ONE RULE THIS DOMAIN EXISTS ON
 * ----------------------------------
 * **A lineage edge is a fact of the GRAPH, never a finding of a regex over
 * SQL.** `inputs` / `outputs` are the edge list; this file enumerates edges by
 * reading them, and `anchor.js` confirms a claim's edge against the same list
 * through the very same {@link lineageEdges} function. SQL text is used for
 * exactly two things — as the *quotable evidence line* a reviewer copies, and
 * as the reason a column is "in play" — and never to decide that an edge
 * exists. A source that grepped `from (\w+)` out of SQL would invent edges for
 * comments, string literals and CTE names, and would miss every edge whose
 * transformation is written in a language the regex does not know (Spark, dbt
 * Jinja, a notebook, a `MERGE`). That failure mode is invisible in a report and
 * expensive in a warehouse, which is why it is designed out here.
 *
 * CANDIDATES: one per lineage edge, plus one per (node, produced table, column)
 * whose column name actually occurs in that node's SQL (or, when the node ships
 * no SQL at all, every column of the tables it produces — with no text there is
 * nothing to narrow by, and a recall-first domain would rather enumerate than
 * silently drop).
 *
 * WHY `candidate.path` IS THE CHAIN'S MODEL FILE, NOT THE NODE'S SCRIPT
 * --------------------------------------------------------------------
 * P2's bundle key must be derivable from the candidate as the ENGINE hands it
 * to `bundleKey.resolve`. Through `adjudication_plan` the engine normalises
 * every candidate to `{path, bytes, additions, deletions, binary, deleted,
 * key}` — `meta` does not survive (that is `toCandidates()` in `index.js`, and
 * `lib/` is out of this domain's scope). A chain key derived from `meta.chain`
 * would therefore silently degrade to one-bundle-per-path in exactly the place
 * the deliverable is judged.
 *
 * So the candidate's `path` IS the artifact that owns the chain, in the same
 * convention dbt uses for a model file:
 *
 *     one output table 'analytics.orders_daily'  ->  models/analytics/orders_daily.sql
 *     several or no output tables                ->  models/_nodes/<node-id>.sql
 *
 * Every candidate of one chain carries that path, which means two DIFFERENT
 * scripts writing the same table land in one bundle (that is the point: a
 * second writer of one table is a finding, not a bundling accident), and
 * `bundleKey.resolve` derives the table back out of the path — so the bundle
 * KEY is `analytics.orders_daily`, not a path.
 *
 * The trade-off is stated rather than hidden: the P1 gate globs the CHAIN
 * artifact, so a path-based exclusion (a vendored directory, for example) fires
 * on it only when the chain itself lives under that directory. The node's own
 * script path is preserved in `locator.nodePath` and `meta.nodePath` for the
 * report, and a note records the convention whenever the two differ.
 *
 * HONESTY: this module only *enumerates*. It does not decide what is reviewable
 * — the P1 gate does — and the two boundary fixtures (`empty`, `all-gated-out`)
 * exist to prove that the "nothing to look at" case and the "nothing survives
 * the gate" case stay distinguishable in the plan.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

/**
 * `candidate.path` must satisfy the contract's id pattern (`ID_PATTERN` in
 * `lib/contracts.js`) or the P1 gate cannot glob it and the whole candidate set
 * disappears into "unsupported file type".
 */
const PATH_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/u

/** The chain-artifact convention this domain's candidates use. */
const CHAIN_ROOT = 'models'

/** `<path> -> <extension>` (without the dot), or `null`. */
function extensionOf(path) {
  const dot = String(path ?? '').lastIndexOf('.')
  return dot < 0 ? null : String(path).slice(dot + 1).toLowerCase()
}

const byteLength = (value) => new TextEncoder().encode(String(value)).length

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Does `line` mention `token` as a STANDALONE token?
 *
 * `orders` must not match `orders_raw`, and `amount` must not match `amount_usd`
 * — a column "in play" because a longer identifier happens to contain its name
 * is exactly the kind of near-miss that makes a rule fire on the wrong thing.
 * `.` is part of the token alphabet so `analytics.orders` matches as one token.
 */
function mentions(line, token) {
  if (typeof token !== 'string' || token === '') return false
  return new RegExp(`(^|[^A-Za-z0-9_.])${escapeRegExp(token)}([^A-Za-z0-9_.]|$)`, 'u').test(String(line))
}

/** The node's SQL as lines; `[]` when it ships none. */
function sqlLinesOf(node) {
  return typeof node?.sql === 'string' && node.sql.trim() !== ''
    ? node.sql.split(/\r?\n/u)
    : []
}

/** The first line of `lines` that mentions `token`, trimmed — or `null`. */
function firstEvidenceLine(lines, token) {
  for (const line of lines) if (mentions(line, token)) return line.trim()
  return null
}

/** A table name as a path segment run: `analytics.orders_daily` -> `analytics/orders_daily`. */
function tableToSegments(table) {
  return String(table)
    .toLowerCase()
    .split('.')
    .map((part) => part.replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, ''))
    .filter((part) => part !== '')
    .join('/')
}

/**
 * The artifact that owns this node's chain (see the header). Kept total: every
 * node produces a globbable path even when its id is hostile.
 */
function chainPathOf(node) {
  const outputs = (Array.isArray(node?.outputs) ? node.outputs : []).map((value) => String(value ?? '').trim()).filter((value) => value !== '')
  const declared = String(node?.path ?? '').replace(/\\/gu, '/').trim()
  const ext = extensionOf(declared) ?? 'sql'
  const declaredSame = declared !== '' && PATH_PATTERN.test(declared) && declared.startsWith(`${CHAIN_ROOT}/`)

  if (outputs.length === 1) {
    const segments = tableToSegments(outputs[0])
    const candidate = `${CHAIN_ROOT}/${segments}.${ext}`
    if (PATH_PATTERN.test(candidate)) return candidate
  }
  if (declaredSame) return declared
  const slug = String(node?.id ?? 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/gu, '-')
  const fallback = `${CHAIN_ROOT}/_nodes/${slug}.${ext}`
  return PATH_PATTERN.test(fallback) ? fallback : `${CHAIN_ROOT}/_nodes/unknown.sql`
}

/**
 * The bundle key a candidate path encodes: the TABLE (the chain), not the path.
 *
 * Exported because the pack's `bundleKey.resolve` must agree with it, and a
 * second implementation of "what is the chain" would be a second thing to get
 * wrong.
 *
 *   models/analytics/orders_daily.sql  ->  analytics.orders_daily
 *   something else                     ->  the path itself (no invented chain)
 */
export function chainKeyFromPath(path) {
  const value = String(path ?? '').replace(/\\/gu, '/')
  const match = new RegExp(`^${CHAIN_ROOT}/([^/]+(?:/[^/]+)*)\\.[a-z0-9]+$`, 'u').exec(value)
  if (match === null) return value
  return match[1].replace(/\//gu, '.')
}

/**
 * THE definition of an edge in this domain — one function, used by the source
 * that enumerates and by the verifier that confirms.
 *
 *   node consumes T  ->  edge { from: T, to: node.id, direction: 'consumed' }
 *   node produces T  ->  edge { from: node.id, to: T, direction: 'produced' }
 *
 * Sharing it is the point: if the two files disagreed about what an edge is,
 * every edge this source enumerated would fail its own anchor check and the
 * disagreement would look like a modelling problem instead of a bug.
 *
 * @param {Array<{id:string,inputs?:string[],outputs?:string[]}>} nodes
 * @returns {Array<{nodeId:string,from:string,to:string,direction:string}>}
 */
export function lineageEdges(nodes) {
  const edges = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node === null || typeof node !== 'object') continue
    const id = String(node.id ?? '').trim()
    if (id === '') continue
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      const from = String(input ?? '').trim()
      if (from !== '') edges.push({ nodeId: id, from, to: id, direction: 'consumed' })
    }
    for (const output of Array.isArray(node.outputs) ? node.outputs : []) {
      const to = String(output ?? '').trim()
      if (to !== '') edges.push({ nodeId: id, from: id, to, direction: 'produced' })
    }
  }
  return edges
}

/**
 * Is the edge a claim names present in the graph?
 *
 * Note what this does NOT do: it does not look at SQL. A claim whose text is
 * present in the node's SQL but whose endpoints are not in `inputs`/`outputs`
 * is a MISREADING of the graph, and it is refused.
 *
 * @param {Array<object>} nodes
 * @param {{nodeId?:string,from?:string,to?:string}} locator
 * @returns {{confirmed:boolean, node:object|null, edges:Array<object>}}
 */
export function edgeConfirmed(nodes, locator) {
  const nodeId = String(locator?.nodeId ?? '')
  const node = (Array.isArray(nodes) ? nodes : []).find((entry) => String(entry?.id ?? '') === nodeId) ?? null
  if (node === null) return { confirmed: false, node: null, edges: [] }
  const edges = lineageEdges([node])
  const from = String(locator?.from ?? '')
  const to = String(locator?.to ?? '')
  return {
    confirmed: edges.some((edge) => edge.from === from && edge.to === to),
    node,
    edges,
  }
}

/**
 * The key a candidate bundles under (P2): one lineage CHAIN / one TABLE.
 * Falls back to `meta.chain` for callers that hand candidates straight from
 * `enumerate()` (where the metadata is still present), and to the path
 * otherwise — which is `bundleKey.resolve` applied to the same candidate.
 *
 * @param {{path?:string, meta?:{chain?:string}}} candidate
 */
export function chainKey(candidate) {
  const chain = candidate?.meta?.chain
  if (typeof chain === 'string' && chain !== '') return chain
  return chainKeyFromPath(candidate?.path)
}

export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'lineage-and-schema 输入必须是对象 { nodes, schema?, runs? }')
  }
  if (!Array.isArray(input.nodes)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'lineage-and-schema 输入缺少数组字段 `nodes`（血缘图的节点表）')
  }
  if (input.schema !== undefined && (input.schema === null || typeof input.schema !== 'object' || Array.isArray(input.schema))) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`schema` 必须是对象 { "db.table": { columns: [...] } }')
  }
  if (input.runs !== undefined && !Array.isArray(input.runs)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`runs` 必须是数组 [{ nodeId, status, at? }]（可省略）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const nodes = input.nodes.filter((node) => node !== null && typeof node === 'object')
  const schema = input.schema ?? {}
  const nodesById = new Map()
  const notes = []
  const excluded = []
  const candidates = []
  let truncated = false

  for (const node of nodes) {
    const id = String(node.id ?? '').trim()
    if (id === '') {
      notes.push('一个节点没有 id，已跳过（血缘边无法归属到一个没有 id 的节点）')
      continue
    }
    if (nodesById.has(id)) {
      notes.push(`节点 id "${id}" 重复出现；只保留第一个（重复的节点会让边的归属变成猜测）`)
      continue
    }
    nodesById.set(id, node)
  }

  // Latest run status per node. A dropped/removed run is the export saying "this
  // table is gone" — the gate's `deleted` predicate, not this file, removes it.
  const latestRun = new Map()
  for (const run of input.runs ?? []) {
    if (run === null || typeof run !== 'object') continue
    const nodeId = String(run.nodeId ?? '')
    if (nodeId === '') continue
    const at = typeof run.at === 'string' ? run.at : ''
    const previous = latestRun.get(nodeId)
    if (previous === undefined || at >= previous.at) latestRun.set(nodeId, { status: String(run.status ?? ''), at })
  }

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  const clipped = (text) => {
    const lines = text.split(/\r?\n/u)
    if (lines.length <= maxExcerptLines) return text
    truncated = true
    notes.push(`一段证据文本超过 maxExcerptLines ${maxExcerptLines}，已截断`)
    return lines.slice(0, maxExcerptLines).join('\n')
  }

  const producedTables = new Set()
  for (const node of nodesById.values()) {
    for (const output of Array.isArray(node.outputs) ? node.outputs : []) producedTables.add(String(output).trim())
  }
  const consumedTables = new Set()
  for (const node of nodesById.values()) {
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) consumedTables.add(String(input).trim())
  }

  let declaredDivergence = 0
  for (const node of nodesById.values()) {
    const id = String(node.id).trim()
    const path = chainPathOf(node)
    const declaredPath = String(node.path ?? '').replace(/\\/gu, '/').trim()
    if (declaredPath !== '' && declaredPath !== path) declaredDivergence += 1
    const lines = sqlLinesOf(node)
    const inputs = (Array.isArray(node.inputs) ? node.inputs : []).map((value) => String(value).trim()).filter((value) => value !== '')
    const outputs = (Array.isArray(node.outputs) ? node.outputs : []).map((value) => String(value).trim()).filter((value) => value !== '')
    const run = latestRun.get(id) ?? null
    const deleted = run !== null && ['dropped', 'removed', 'deleted'].includes(run.status)
    const chain = outputs.length === 1 ? outputs[0] : `_nodes.${id}`
    const owner = outputs.length === 1 ? outputs[0] : null

    // --- one candidate per lineage EDGE -------------------------------------
    for (const [from, to, direction, counterpart] of [
      ...inputs.map((table) => [table, id, 'consumed', table]),
      ...outputs.map((table) => [id, table, 'produced', table]),
    ]) {
      const evidence = firstEvidenceLine(lines, counterpart)
      const text = evidence ?? `lineage: ${from} -> ${to}（节点 "${id}" 没有提供含该标识符的 SQL 文本，只有图结构证据）`
      push({
        id: `${id}#edge#${from}->${to}`,
        path,
        locator: { nodeId: id, from, to, direction, nodePath: declaredPath === '' ? null : declaredPath },
        text: clipped(text),
        bytes: byteLength(text),
        deleted,
        // File-level facts travel with every candidate so the gate sees them.
        binary: node.binary === true,
        meta: {
          kind: 'edge',
          nodeId: id,
          from,
          to,
          direction,
          chain,
          owner,
          nodePath: declaredPath === '' ? null : declaredPath,
          evidenceKind: evidence === null ? 'graph-only' : 'sql-line',
          bodyLines: lines.length,
          lastRunStatus: run?.status ?? null,
        },
      })
    }

    // --- one candidate per (node, produced table, column in play) -----------
    for (const table of outputs) {
      const declared = schema[table]
      const columns = Array.isArray(declared?.columns) ? declared.columns : []
      for (const column of columns) {
        if (column === null || typeof column !== 'object') continue
        const name = String(column.name ?? '').trim()
        if (name === '') continue
        // "In play": the node's SQL actually names the column. With no SQL at
        // all there is nothing to narrow by, so every column of a produced table
        // is enumerated and flagged — silently dropping them would be a
        // precision-first reflex in a recall-first domain.
        const evidence = firstEvidenceLine(lines, name)
        if (evidence === null && lines.length > 0) continue
        const text = evidence ?? `${table}.${name} (${String(column.type ?? 'unknown')}, nullable=${String(column.nullable)})`
        push({
          id: `${id}#column#${table}.${name}`,
          path,
          locator: { nodeId: id, table, column: name, nodePath: declaredPath === '' ? null : declaredPath },
          text: clipped(text),
          bytes: byteLength(text),
          deleted,
          binary: node.binary === true,
          meta: {
            kind: 'column',
            nodeId: id,
            table,
            column: name,
            chain: table,
            nodePath: declaredPath === '' ? null : declaredPath,
            nullable: column.nullable === true,
            columnType: column.type ?? null,
            evidenceKind: evidence === null ? 'schema-only' : 'sql-line',
          },
        })
      }
    }
  }

  if (declaredDivergence > 0) {
    // The convention is load-bearing for P2, so it is stated in the plan rather
    // than left for a reader to reverse-engineer from a path that does not exist
    // on disk.
    notes.push(
      `候选路径使用「链的模型文件」约定（${CHAIN_ROOT}/<schema>/<table>.<ext>）：${declaredDivergence} 个节点声明的脚本路径与它不同，`
      + '真实脚本路径保存在 locator.nodePath / meta.nodePath 中。',
    )
  }

  // --- what the graph itself cannot place ---------------------------------
  for (const node of nodesById.values()) {
    const id = String(node.id).trim()
    const inputs = Array.isArray(node.inputs) ? node.inputs.length : 0
    const outputs = Array.isArray(node.outputs) ? node.outputs.length : 0
    if (inputs === 0 && outputs === 0) {
      excluded.push({
        id,
        reason: `孤儿节点 "${id}"：既没有 inputs 也没有 outputs —— 它不在任何一条血缘边上，没有可判定的关系`,
      })
    }
  }
  for (const [table, declared] of Object.entries(schema)) {
    if (producedTables.has(table) || consumedTables.has(table)) continue
    excluded.push({
      id: `schema:${table}`,
      reason: `孤儿表 "${table}"：没有任何节点声明 inputs/outputs —— 它的字段不在任何一条血缘边上（${Array.isArray(declared?.columns) ? declared.columns.length : 0} 个字段未枚举）`,
    })
  }

  return {
    candidates,
    excluded,
    notes,
    bounded: true,
    truncated,
  }
}

export default defineCandidateSource({
  kind: 'lineage-edges-and-columns',
  inputFormat: 'lineage-and-schema',
  bounded: true,
  describe: '血缘图 + 仓库 schema → 每条边一个候选，另加每个「SQL 里出现过的」产出字段一个候选；候选路径是链的模型文件（models/<schema>/<table>.<ext>），孤儿节点/孤儿表进入 excluded 并说明原因。',
  enumerate,
})
