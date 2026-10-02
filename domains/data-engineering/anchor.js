/**
 * data-engineering — P5 anchor verifier (contract v2, extension point 2).
 *
 * WHAT AN ANCHOR IS IN THIS DOMAIN
 * --------------------------------
 * 「表名.字段 + 血缘节点」 — and, before any text is looked at, **the edge has to
 * exist in the lineage graph**. That ordering is the whole design:
 *
 *   1. structural  — the claim names a node, and (for an edge claim) that
 *                    `from -> to` really is one of that node's `inputs`/
 *                    `outputs`, recomputed through `lineageEdges()` from
 *                    `source.js` — the same function the P0 enumeration used.
 *                    For a column claim, the (table, column) must exist in the
 *                    supplied schema AND the table must be produced by that
 *                    node, so a column cannot be anchored to a node that never
 *                    touches it.
 *   2. textual     — the reviewer's copied line must be present VERBATIM in the
 *                    node's SQL, and the engine recomputes where.
 *
 * A claim that passes (2) and fails (1) is the characteristic failure of this
 * domain: a plausible SQL line quoted to support an edge that the graph does not
 * contain. It is refused — `locator-mismatch`, `code: 'edge-unconfirmed'` — and
 * the refusal lists the node's real edges so the reviewer can see what it
 * misread. Nothing here is repaired by guessing.
 *
 * HOW THE GRAPH REACHES THE VERIFIER
 * ----------------------------------
 * Two channels, and both are real:
 *
 *   • `subject.lineage` — the export itself, when a caller uses the library
 *     (`anchor.verify(claim, { documents, lineage })`, which the domain's test
 *     does);
 *   • a DOCUMENT whose content is that export — the domain's convention is
 *     `{ path: 'lineage/graph.json', content: <the same payload P0 was fed> }`.
 *
 * The second channel exists because the engine's recompute path
 * (`recomputeAnchor()` in `index.js`) hands a verifier only `{ path, content,
 * document, documents }` — there is nowhere else for a structured subject to
 * travel, and `adjudication_submit` recomputes every finding's anchor. Without
 * it, every finding in this domain would be refused with "no graph". Because the
 * graph arrives as a document, the model cannot invent edges: the graph it is
 * checked against is the one the plan was given.
 *
 * The distinct refusal codes all map onto the contract's DECLARED tiers (an
 * undeclared tier would fail `validateAnchorVerdict`); the domain-specific
 * reason travels in `code` and `detail`.
 *
 * Degradation ladder (tiers are the contract's, verbatim):
 *   declared-locator    the copied line really is at the line the claim named
 *   recomputed-unique   no usable line number, and the line is at exactly ONE place
 *   relocated-unique    the named document does not hold it, exactly ONE other does
 *   locator-mismatch    the claim contradicts the subject (wrong line, wrong
 *                       edge, unknown node/chain/column, no graph) — terminal
 *   relocation-ambiguous two or more equally valid locations — terminal
 *   no-match / empty-excerpt / kind-mismatch / no-documents — terminal
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'
import { allMatches, matchesAt } from '../code-review/anchor.js'
import { chainKeyFromPath, edgeConfirmed, lineageEdges } from './source.js'

/**
 * Strip a diff marker and ALL whitespace — the comparison form of one line.
 *
 * Identical to the rule `domains/code-review/anchor.js` applies (`normalizeLine`,
 * itself ported from open-code-review `internal/diff/resolver.go:301`): only
 * indentation, diff markers and line-ending noise are tolerated. A re-indented
 * paste anchors; a paraphrase, a renamed identifier or a changed punctuation
 * mark does NOT. `allMatches`/`matchesAt` are imported from that file rather
 * than copied, so all migrated domains share one comparison rule and one place
 * to change it.
 */
const normalizeLine = (line) => String(line).replace(/^[+-]/u, '').replace(/\s+/gu, '')

/** Normalise an excerpt into its comparison lines. Blank lines are dropped. */
function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

/** The anchor kind this domain verifies. Declared before use, deliberately. */
const KIND = 'lineage-ref'

/** The document convention that carries the lineage export (see the header). */
const GRAPH_DOCUMENT = /^lineage\/[a-z0-9._-]*\.json$/u

const lineCount = (content) => String(content).split(/\r?\n/u).length

const unanchored = (tier, code, detail, extra = {}) => ({
  status: 'unanchored',
  tier,
  code,
  path: null,
  start: null,
  end: null,
  detail,
  ...extra,
})

const anchored = (path, start, end, tier, code, detail) => ({
  status: 'anchored',
  tier,
  code,
  path,
  start,
  end,
  detail,
})

/** `subject.documents` -> `[{ path, content }]`, tolerating `{ path, text }`. */
function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string'
      ? entry.content
      : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    documents.push({ path, content })
  }
  return documents
}

/**
 * The lineage graph, from `subject.lineage`, from a graph DOCUMENT, or from the
 * subject's own `content` (the self-folded form).
 *
 * WHY THE THIRD FORM EXISTS: through `adjudication_anchor` the engine collapses
 * whatever the caller supplied into `{ path, content, document, documents }` —
 * a structured `subject.lineage` field does not survive that trip. A caller that
 * hands the lineage EXPORT back as the subject document (path `lineage/*.json`,
 * content the JSON text) is handing back exactly the input material the review
 * was based on, so the domain must be able to read it back out of `content`.
 * This is not a bypass: the parsed graph is then used for the SAME edge/schema
 * recomputation as before, and a wrong graph still produces `edge-unconfirmed`.
 *
 * @returns {{nodes:object[], schema:object|null, source:string}|null}
 */
function toGraph(subject) {
  const direct = subject?.lineage
  if (Array.isArray(direct)) return { nodes: direct, schema: null, source: 'subject.lineage' }
  if (direct !== null && typeof direct === 'object' && Array.isArray(direct.nodes)) {
    return { nodes: direct.nodes, schema: direct.schema ?? null, source: 'subject.lineage' }
  }
  for (const document of toDocuments(subject)) {
    if (!GRAPH_DOCUMENT.test(document.path)) continue
    let parsed = null
    try {
      parsed = JSON.parse(document.content)
    } catch {
      continue
    }
    if (Array.isArray(parsed?.nodes)) {
      return { nodes: parsed.nodes, schema: parsed.schema ?? null, source: document.path }
    }
  }
  // Third form: the subject IS the export. Shape-checked, so a note or a SQL file
  // whose text happens to be valid JSON cannot be mistaken for the graph.
  if (typeof subject?.content === 'string' && subject.content.trim() !== '') {
    try {
      const parsed = JSON.parse(subject.content)
      if (Array.isArray(parsed?.nodes)) {
        return { nodes: parsed.nodes, schema: parsed.schema ?? null, source: 'subject.content' }
      }
    } catch {
      return null
    }
  }
  return null
}

/** Is this document the graph payload rather than prose evidence? */
function isStructuredDocument(document) {
  if (!GRAPH_DOCUMENT.test(document.path)) return false
  try {
    const parsed = JSON.parse(document.content)
    return Array.isArray(parsed?.nodes)
  } catch {
    return false
  }
}

/** The schema map, tolerating `subject.schema` / `subject.lineage.schema`. */
function toSchema(subject, graph) {
  const direct = subject?.schema
  if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) return direct
  const nested = subject?.lineage?.schema
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) return nested
  return graph?.schema ?? null
}

/**
 * The textual half of the ladder — identical in shape to the reference domain's,
 * so "anchored" means the same thing in every migrated domain.
 */
function locateText(claim, subject, preferred) {
  const needle = normalizeExcerpt(claim.excerpt ?? '')
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null
  // A document NAMED by the claim wins over the subject's own content: when the
  // caller folds the lineage export into `content` (self-folded subject) and hands
  // the node SQL back inside `documents`, the prose to search is the SQL — not the
  // JSON export. The `content` fallback therefore applies only when the subject's
  // own document IS the one the claim names (or names nothing); otherwise the
  // claim points at a file nobody handed back, which is what the relocation ladder
  // below exists for.
  const subjectIsNamed = subjectContent !== null
    && (subject?.path === undefined || subject?.path === null || subject.path === preferred)
  const named = documents.find((document) => document.path === preferred)
    ?? (subjectIsNamed ? { path: preferred, content: subjectContent } : null)
  // Structured payloads are DATA, not prose: an excerpt must never "relocate"
  // into a line of the lineage export.
  const others = documents.filter((document) => document.path !== preferred && !isStructuredDocument(document))
  // A structured lineage payload is DATA, never prose: the filter above is what
  // makes `a structured payload document is DATA, not prose: an excerpt never
  // relocates into it` true, and `test.mjs` pins it so it cannot pass for the
  // wrong reason. But the refusal that follows must not claim "no comparable
  // document contains this text" when one demonstrably does. That message is
  // false, and a false reason sends the caller hunting for a typo that is not
  // there instead of quoting the node's SQL. So the structured holders are found
  // here and named in the refusal.
  const structuredHolders = documents
    .filter((document) => document.path !== preferred && isStructuredDocument(document))
    .filter((document) => allMatches(document.content, needle).length > 0)
    .map((document) => document.path)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', 'no-documents', '没有提供任何可比对的文档内容 —— 无法重算锚点')
  }
  if (named !== null) {
    const declared = claim.locator?.startLine
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return anchored(named.path, declared, declared + needle.length - 1, 'declared-locator', 'quoted-line-at-declared-line',
          `第 ${declared} 行确认无误（共 ${lineCount(named.content)} 行）`)
      }
      return unanchored('locator-mismatch', 'locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }
    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique', 'quoted-line-recomputed',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号`)
    }
    if (hits.length === 0) {
      return unanchored('no-match', 'no-match',
        `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁（转述不是抄写）`)
    }
    return unanchored('relocation-ambiguous', 'relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }
  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return anchored(only.path, only.start, only.end, 'relocated-unique', 'quoted-line-relocated',
      `声明的 "${preferred}" 不在可比对文档中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁`)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous', 'relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对文档中，且原文在 ${hits.length} 处命中 —— 跨文件搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  if (structuredHolders.length > 0) {
    return unanchored('no-match', 'no-match',
      `抄写原文逐字出现在结构化血缘导出 ${structuredHolders.join('、')} 里，但它是 DATA 而不是 prose：本域只从它重算节点与边，不拿它当可引用原文（一条 JSON 行永远不等于一段 SQL）。`
      + `请引用节点自己的 SQL 那一行 —— 本域按节点 SQL 定位原文。`)
  }
  return unanchored('no-match', 'no-match', `声明的 "${preferred}" 与任何可比对文档都不含这段原文`)
}

/** Does any node in the graph touch this table, in either direction? */
function chainKnown(nodes, table) {
  for (const node of nodes) {
    const sides = [
      ...(Array.isArray(node?.inputs) ? node.inputs : []),
      ...(Array.isArray(node?.outputs) ? node.outputs : []),
    ]
    if (sides.some((value) => String(value ?? '').trim() === table)) return true
  }
  return false
}

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:Array<{path:string,content:string}>,
 *          lineage?:object|Array<object>, schema?:object}} subject
 * @returns {object} an AnchorVerdict — see the tier table at the top of the file
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt? }')
  }
  if (typeof claim.kind !== 'string' || claim.kind === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (typeof claim.path !== 'string' || claim.path === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可省略）')
  }

  if (claim.kind !== KIND) {
    return unanchored('kind-mismatch', 'kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }

  const locator = claim.locator ?? {}
  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', 'empty-excerpt',
      '抄写的原文规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const graph = toGraph(subject)
  if (graph === null) {
    // The teeth of this domain: with no graph there is no way to confirm an edge,
    // and confirming it from SQL text is exactly what this domain refuses to do.
    return unanchored('no-documents', 'no-lineage',
      `没有提供血缘图 —— 本领域不用 SQL 文本代替图结构。请把 P0 用的那份导出作为文档传进来（约定路径 lineage/graph.json），`
      + '或通过 subject.lineage 直接给出。')
  }
  const nodes = graph.nodes.filter((node) => node !== null && typeof node === 'object')

  const nodeId = String(locator.nodeId ?? '')

  if (nodeId === '') {
    // A chain-level claim: no edge named, so only the CHAIN can be confirmed.
    // This is what `adjudication_anchor` can reach today — its parameters carry
    // no domain locator — and it is reported as a weaker confirmation, never as
    // an edge that was checked.
    const table = chainKeyFromPath(claim.path)
    if (table === claim.path) {
      return unanchored('locator-mismatch', 'incomplete-locator',
        'locator 缺少 nodeId，且 claim.path 不是本领域的链模型路径（models/<schema>/<table>.<ext>）—— 无法确认任何边，拒绝猜测')
    }
    if (!chainKnown(nodes, table)) {
      return unanchored('locator-mismatch', 'unknown-chain',
        `血缘图里没有任何节点触及 "${table}" —— 声明与输入矛盾`, { table })
    }
    const result = locateText(claim, subject, claim.path)
    if (result.status === 'anchored') {
      result.code = 'chain-confirmed'
      result.detail = `${result.detail}；链 "${table}" 在血缘图中存在，但这次没有声明具体是哪条边 —— 边未确认`
      result.table = table
    }
    return result
  }

  const isColumnClaim = typeof locator.column === 'string' && locator.column !== ''

  if (!isColumnClaim) {
    const from = String(locator.from ?? '')
    const to = String(locator.to ?? '')
    if (from === '' || to === '') {
      return unanchored('locator-mismatch', 'incomplete-locator',
        '边锚点的 locator 必须同时给出 nodeId / from / to —— 缺一个就无法与图比对')
    }
    const check = edgeConfirmed(nodes, locator)
    if (check.node === null) {
      return unanchored('locator-mismatch', 'unknown-node',
        `血缘图里没有节点 "${nodeId}" —— 声明与输入矛盾`)
    }
    if (!check.confirmed) {
      const actual = check.edges.map((edge) => `${edge.from} -> ${edge.to}`).join(' | ') || '(该节点没有任何边)'
      return unanchored('locator-mismatch', 'edge-unconfirmed',
        `血缘图里节点 "${nodeId}" 没有 "${from} -> ${to}" 这条边（它的边是：${actual}）—— 原文再像也不能证明一条图上不存在的边`,
        { nodeId, actualEdges: check.edges.map((edge) => ({ from: edge.from, to: edge.to, direction: edge.direction })) })
    }
    const result = locateText(claim, subject, claim.path)
    if (result.status === 'anchored') {
      result.code = 'edge-confirmed'
      result.detail = `${result.detail}；边 ${from} -> ${to} 已在血缘图中确认（节点 ${nodeId}）`
      result.nodeId = nodeId
    }
    return result
  }

  // --- column claim: schema + the edge that makes the column reachable -------
  const schema = toSchema(subject, graph)
  if (schema === null) {
    return unanchored('no-documents', 'no-schema',
      '没有提供 schema —— 字段锚点必须与列定义比对，不能只靠 SQL 文本')
  }
  const table = String(locator.table ?? '')
  const column = String(locator.column)
  if (table === '') {
    return unanchored('locator-mismatch', 'incomplete-locator', '字段锚点的 locator 必须给出 table')
  }
  const check = edgeConfirmed(nodes, { nodeId, from: nodeId, to: table })
  if (check.node === null) {
    return unanchored('locator-mismatch', 'unknown-node', `血缘图里没有节点 "${nodeId}" —— 声明与输入矛盾`)
  }
  if (!check.confirmed) {
    return unanchored('locator-mismatch', 'column-not-on-edge',
      `节点 "${nodeId}" 并不产出 "${table}" —— 该字段不在这条血缘链上，无法锚定到它`,
      { nodeId, table })
  }
  const declared = schema[table]
  const columns = Array.isArray(declared?.columns) ? declared.columns : []
  const found = columns.find((entry) => String(entry?.name ?? '') === column) ?? null
  if (columns.length === 0) {
    return unanchored('locator-mismatch', 'unknown-table', `schema 里没有 "${table}" 的列定义`)
  }
  if (found === null) {
    return unanchored('locator-mismatch', 'unknown-column',
      `schema 里 "${table}" 没有字段 "${column}"（它有：${columns.map((entry) => String(entry?.name ?? '')).join(', ')}）`,
      { nodeId, table, knownColumns: columns.map((entry) => String(entry?.name ?? '')) })
  }
  const result = locateText(claim, subject, claim.path)
  if (result.status === 'anchored') {
    result.code = 'column-confirmed'
    result.detail = `${result.detail}；字段 ${table}.${column}（${String(found.type ?? 'unknown')}，nullable=${String(found.nullable)}）已在 schema 中确认`
    result.nodeId = nodeId
  }
  return result
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '血缘锚点：先在血缘 JSON 里重算这条边/这个字段是否真的存在（图可以由 subject.lineage 或约定文档 lineage/graph.json 提供），再在节点 SQL 里逐字定位抄写的原文；图里没有的边一律未锚定，绝不用 SQL 文本代替图结构。',
  verify,
})

/** Re-exported for the domain's own tests and evidence tools. */
export { allMatches, matchesAt, lineageEdges }
