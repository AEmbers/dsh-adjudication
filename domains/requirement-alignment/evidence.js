/**
 * requirement-alignment — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT THESE ARE FOR
 * ------------------
 * A bounded reviewer needs to ask questions OF THE TRACE GRAPH, and the only thing
 * it may not have is unlimited access. Each tool declares `limits`;
 * `normaliseEvidenceLimits` clamps it to the contract's ceilings, and the engine
 * refuses to register a tool that declares none. Every result carries
 * `{ items, truncated, provenance }` — a result that was cut short says so.
 *
 * Four questions cover what a traceability reviewer can ask without inventing
 * context:
 *
 *   gap_report       where does the chain break, ITEM BY ITEM?      (the P0 question)
 *   chain_routes     every route from A to B, bounded              (is the reading unique?)
 *   node_neighbours  what does this node wait on / lead to?         (both directions)
 *   ref_check        is this cross-domain ref consumable, and stale? (the meta question)
 *
 * WHY `gap_report` EXISTS AND WHY IT LISTS RATHER THAN COUNTS
 * ----------------------------------------------------------
 * This domain is `recall-first`: missing a real traceability gap costs more than
 * reporting a doubtful one. A tool that answered "coverage: 62%" would be worse than
 * useless — a percentage cannot be adjudicated, cannot be anchored, and cannot be
 * fixed. So `gap_report` returns ONE ITEM PER GAP, each naming the node, the missing
 * side and the reason, and its `items` list IS the missing-link list the report has
 * to carry. The percentage is computed downstream from these items, never instead of
 * them.
 *
 * WHY THESE READ `args.corpus` AND NOT FILES
 * ------------------------------------------
 * The caller injects the graph documents. This package has zero runtime imports and
 * an evidence tool that reached for `node:fs` would break that on the first host
 * that links the plugin instead of installing it. It also means the tools answer
 * about the SAME corpus the anchor verifier sees: a tool that re-read the filesystem
 * could confirm a claim about a graph the verifier never saw.
 *
 * THE ONE ASYMMETRY, STATED
 * -------------------------
 * `chain_routes` runs a depth-first search, and a DFS is the obvious way to turn a
 * small tool into an unbounded one. Both bounds (`maxDepth`, `maxPaths`) are declared
 * in `parameters` and reported in `provenance`, and hitting either sets
 * `truncated: true`. A caller that gets `truncated: true` has learned that the
 * ABSENCE of a route in `items` is NOT evidence that no route exists — which is
 * exactly the inference the flag exists to block. `gap_report` inherits the same
 * caveat: a truncated gap report is not a complete list of gaps, and it says so.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'
import { clipLines, isOrphan, simplePaths, slash } from '../_lib/graph.js'
import {
  IMPLEMENTATION_TYPE,
  REQUIREMENT_TYPE,
} from './anchor.js'
import {
  declaredIds,
  edgeTriples,
  nodeFacts,
  refShape,
  upstreamSet,
} from './source.js'

const CORPUS_SCHEMA = {
  type: 'array',
  description: '追踪图语料：[{ path, type?, payload: { nodes, edges, idSpace?, upstream? }, meta? }]。必须由调用方注入；工具自身不读文件系统。',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: {
      path: { type: 'string' },
      type: { type: 'string' },
      payload: { type: 'object' },
    },
  },
}

/**
 * Normalise `args.corpus`, accepting a bare payload as a convenience.
 *
 * A bare `{ nodes: [...], edges: [...] }` is what a caller naturally has when the
 * chain is one document with no meta. Rejecting it would push every such caller into
 * wrapping it by hand, and the wrapping is pure ceremony.
 */
function corpusFrom(args) {
  const raw = args?.corpus
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `corpus`：[{ path, payload }]。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  const documents = []
  let index = 0
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    index += 1
    if (Array.isArray(entry.nodes) || Array.isArray(entry.edges)) {
      documents.push({ path: slash(entry.path ?? `corpus/${index}/trace.json`), type: 'trace-graph', payload: entry, meta: entry.meta ?? {} })
      continue
    }
    if (entry.payload !== null && typeof entry.payload === 'object') {
      documents.push({
        path: slash(entry.path ?? `corpus/${index}/trace.json`),
        type: entry.type ?? 'trace-graph',
        payload: entry.payload,
        meta: entry.meta ?? {},
      })
    }
  }
  if (documents.length === 0) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'corpus 里没有可读的追踪图文档（需要 path + payload.nodes/edges）')
  }
  return documents
}

/** The document a request names, or a loud failure listing what is available. */
function resolveDocument(documents, path) {
  const wanted = slash(path ?? '')
  const exact = documents.find((document) => document.path === wanted)
  if (exact !== undefined) return exact
  const suffix = documents.find((document) => document.path.endsWith(wanted))
  if (suffix !== undefined && wanted !== '') return suffix
  throw contractError(ERROR_CODES.E_INPUT_FORMAT,
    `语料里没有追踪图 "${wanted}"。可比对的有：${documents.map((document) => document.path).join(', ')}`)
}

const scopeOf = (documents, path) => (path === undefined || path === null
  ? documents
  : [resolveDocument(documents, path)])

/** Neighbour structure of one document, seeded so isolated nodes are visible. */
function neighboursOf(document) {
  const outgoing = new Map()
  const incoming = new Map()
  for (const [from, to, kind] of edgeTriples(document)) {
    if (!outgoing.has(from)) outgoing.set(from, [])
    outgoing.get(from).push({ to, kind })
    if (!incoming.has(to)) incoming.set(to, [])
    incoming.get(to).push({ from, kind })
  }
  for (const id of declaredIds(document)) {
    if (!outgoing.has(id)) outgoing.set(id, [])
    if (!incoming.has(id)) incoming.set(id, [])
  }
  return { outgoing, incoming }
}

/** Every reachability question this file asks goes through here, bounded. */
function reachable(edges, from, to, { maxDepth = 8, maxPaths = 12 } = {}) {
  return simplePaths(from, to, edges, { maxDepth, maxPaths })
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'gap_report',
      description: '逐条列出追踪链上的缺口：需求未走到实现、实现没有需求可达、边端点没有节点记录、节点没有 ref、ref 失效或无法消费。一件缺口一个条目，不做百分比汇总。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '追踪图文档路径（可省略，省略则报告全部语料）' },
          maxDepth: { type: 'integer', description: '可达性搜索深度上限，默认 8，硬上限 12' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 400, maxItems: 120, maxBytes: 131_072, maxCalls: 6 },
      execute(args) {
        const documents = corpusFrom(args)
        const maxDepth = Math.min(Math.max(1, Number(args?.maxDepth) || 8), 12)
        const scoped = scopeOf(documents, args?.path)
        const upstream = upstreamSet(scoped)
        const items = []
        let truncated = false
        let examined = 0

        const add = (item) => {
          if (items.length >= 120) { truncated = true; return }
          items.push(item)
        }

        for (const document of scoped) {
          const nodes = Array.isArray(document.payload.nodes) ? document.payload.nodes : []
          const triples = edgeTriples(document)
          const edges = triples.map(([from, to]) => [from, to])
          const declared = declaredIds(document)
          const known = new Set([
            ...declared,
            ...(Array.isArray(document.payload.idSpace) ? document.payload.idSpace : []),
          ])
          const typeOf = (id) => {
            const node = nodes.find((entry) => entry?.id === id)
            return typeof node?.type === 'string' && node.type !== '' ? node.type : null
          }
          const implementations = declared.filter((id) => typeOf(id) === IMPLEMENTATION_TYPE)
          const requirements = declared.filter((id) => typeOf(id) === REQUIREMENT_TYPE)

          // 1. forward coverage — a requirement that cannot reach any implementation
          for (const id of requirements) {
            examined += 1
            if (implementations.length === 0) {
              add({
                path: document.path, kind: 'no-implementation-node', nodeId: id, side: 'downstream',
                reason: `需求 ${id} 所在图里没有任何 type=${IMPLEMENTATION_TYPE} 的节点 —— 缺口在整张图上，不在这一条链上`,
              })
              continue
            }
            const reached = implementations.filter((target) => reachable(edges, id, target, { maxDepth }).paths.length > 0)
            if (reached.length === 0) {
              add({
                path: document.path, kind: 'uncovered-requirement', nodeId: id, side: 'downstream',
                candidates: implementations,
                reason: `需求 ${id} 走不到任何实现节点（${implementations.join('、')}）—— 前向覆盖缺失`,
              })
            }
          }

          // 2. backward traceability — an implementation nothing points at
          for (const id of implementations) {
            examined += 1
            const sources = requirements.filter((source) => reachable(edges, source, id, { maxDepth }).paths.length > 0)
            if (sources.length === 0) {
              add({
                path: document.path, kind: 'untraceable-implementation', nodeId: id, side: 'upstream',
                candidates: requirements,
                reason: `实现 ${id} 没有任何需求能走到它 —— 反向溯源缺失（它可能是凭空做的，也可能是某条边断了）`,
              })
            }
          }

          // 3. dangling endpoints — an edge whose endpoint has no node record
          for (const [from, to, kind] of triples) {
            examined += 1
            for (const [side, id] of [['from', from], ['to', to]]) {
              if (known.has(id)) continue
              add({
                path: document.path, kind: 'dangling-endpoint', nodeId: id, side: side === 'from' ? 'upstream' : 'downstream',
                edge: { from, to, kind },
                reason: `边 ${from}→${to}（${kind}）的${side === 'from' ? '起点' : '终点'} ${id} 不在本图的节点记录里，也不在 idSpace 里 —— 断链`,
              })
            }
          }

          // 4. bindings — a node with no ref, an opaque ref, a stale ref
          for (const node of nodes) {
            examined += 1
            const id = typeof node?.id === 'string' ? node.id : ''
            if (id === '') continue
            const facts = nodeFacts(node)
            if (facts.missingRef) {
              add({
                path: document.path, kind: 'missing-ref', nodeId: id, side: 'upstream',
                reason: `节点 ${id}（type=${node.type ?? '?'}）没有绑定任何跨域锚点 —— 它无法被验证，也无法被追溯`,
              })
              continue
            }
            const shape = refShape(facts.ref)
            if (shape === null) {
              add({
                path: document.path, kind: 'opaque-ref', nodeId: id, side: 'upstream', ref: facts.ref,
                reason: `节点 ${id} 的 ref "${facts.ref}" 不是任何已知上游域产出的锚点形状 —— 无法消费`,
              })
              continue
            }
            if (upstream.declared && !upstream.refs.has(facts.ref)) {
              add({
                path: document.path, kind: 'stale-ref', nodeId: id, side: 'upstream',
                ref: facts.ref, refDomain: shape.domain, refForm: shape.form,
                refBasis: shape.basis, refBasisDetail: shape.basisDetail ?? null,
                reason: `节点 ${id} 的 ref "${facts.ref}" 已被 upstream[] 移出产出集合 —— 失效链接（上游改了，这里没跟着改）`,
              })
            }
          }

          // 5. isolated nodes — no edge at all, so no edge-based rule can reach them
          const { outgoing, incoming } = neighboursOf(document)
          for (const id of declared) {
            if (isOrphan({ out: outgoing.get(id) ?? [], in: incoming.get(id) ?? [] })) {
              add({
                path: document.path, kind: 'isolated-node', nodeId: id, side: 'both',
                reason: `节点 ${id} 在图上没有任何入边或出边 —— 它既不被追溯，也不追溯任何东西`,
              })
            }
          }
        }

        return {
          items,
          truncated,
          provenance: `${scoped.length} 张图 / 检查 ${examined} 个元素，列出 ${items.length} 条缺口；深度上限 ${maxDepth}；upstream 声明：${upstream.declared ? `有（${upstream.refs.size} 个 ref）` : '**无（失效链接问题无法回答）**'}`,
          notes: [
            '本清单是**逐条缺口**，不是覆盖率百分比：每条都给出 kind + nodeId + 理由。',
            truncated ? '条数达到 maxItems=120，结果已截断 —— 未列出的缺口不代表不存在' : '',
            upstream.declared ? '' : 'upstream[] 未声明：本次只检查了 ref 的形状，未检查它是否仍然有效。',
          ].filter((note) => note !== ''),
        }
      },
    },
    {
      name: 'chain_routes',
      description: '在追踪图上深度优先搜索 from 到 to 的简单路径（有界：maxDepth / maxPaths）。返回的路径条数即为「这条链的读法是否唯一」的证据。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点节点 ID' },
          to: { type: 'string', description: '终点节点 ID' },
          maxDepth: { type: 'integer', description: '最大搜索深度，默认 8，硬上限 12' },
          maxPaths: { type: 'integer', description: '最多返回路径条数，默认 12，硬上限 24' },
          path: { type: 'string', description: '追踪图文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['from', 'to', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 80, maxItems: 24, maxBytes: 32_768, maxCalls: 6 },
      execute(args) {
        const from = String(args?.from ?? '')
        const to = String(args?.to ?? '')
        if (from === '' || to === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`from` 与 `to` 都不能为空')
        const maxDepth = Math.min(Math.max(1, Number(args?.maxDepth) || 8), 12)
        const maxPaths = Math.min(Math.max(1, Number(args?.maxPaths) || 12), 24)
        const documents = corpusFrom(args)
        const scoped = scopeOf(documents, args?.path)
        const items = []
        let truncated = false
        for (const document of scoped) {
          const edges = edgeTriples(document).map(([a, b]) => [a, b])
          const found = simplePaths(from, to, edges, { maxDepth, maxPaths })
          if (found.truncated) truncated = true
          for (const route of found.paths) items.push({ path: document.path, route })
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 张图；from=${from} to=${to}；深度上限 ${maxDepth}，路径上限 ${maxPaths}；命中 ${items.length} 条路径`,
          notes: truncated
            ? ['搜索触到深度或路径上限：items 里没有路径**不构成**「链断了」的证据，请提高上限或改用更小的子图重问']
            : [],
        }
      },
    },
    {
      name: 'node_neighbours',
      description: '某节点在图上的双向邻居：谁指向它、它指向谁，以及它是否孤点、ref 是否可消费。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '节点 ID' },
          path: { type: 'string', description: '追踪图文档路径（可省略：会在全部语料里查找该 ID）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['nodeId', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 120, maxItems: 40, maxBytes: 65_536, maxCalls: 12 },
      execute(args) {
        const nodeId = String(args?.nodeId ?? '')
        if (nodeId === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`nodeId` 不能为空')
        const documents = corpusFrom(args)
        const scoped = scopeOf(documents, args?.path)
        const upstream = upstreamSet(scoped)
        const items = []
        const notes = []
        for (const document of scoped) {
          const declared = declaredIds(document)
          const { outgoing, incoming } = neighboursOf(document)
          const inGraph = declared.includes(nodeId)
            || (outgoing.get(nodeId)?.length ?? 0) > 0
            || (incoming.get(nodeId)?.length ?? 0) > 0
          if (!inGraph) continue
          if (items.length >= 40) { notes.push('邻居条目数达到 maxItems=40，结果已截断'); break }
          const node = (Array.isArray(document.payload.nodes) ? document.payload.nodes : []).find((entry) => entry?.id === nodeId)
          const facts = nodeFacts(node)
          items.push({
            path: document.path,
            nodeId,
            hasRecord: declared.includes(nodeId),
            type: typeof node?.type === 'string' ? node.type : null,
            outgoing: outgoing.get(nodeId) ?? [],
            incoming: incoming.get(nodeId) ?? [],
            orphan: isOrphan({ out: outgoing.get(nodeId) ?? [], in: incoming.get(nodeId) ?? [] }),
            ref: facts.ref,
            refDomain: facts.shape?.domain ?? null,
            refForm: facts.shape?.form ?? null,
            refBasis: facts.shape?.basis ?? null,
            refConsumable: facts.shape !== null,
            refStale: facts.ref !== null && facts.shape !== null && upstream.declared
              ? !upstream.refs.has(facts.ref)
              : null,
          })
        }
        if (items.length === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `语料里没有节点 "${nodeId}"。它可能是只出现在边上、却没有节点记录的**断链端点** —— 那是一条发现，不是一个可以补全的查询。`)
        }
        return {
          items,
          truncated: notes.length > 0,
          provenance: `${scoped.length} 张图，命中 ${items.length} 处；nodeId=${nodeId}；upstream 声明：${upstream.declared ? '有' : '无'}`,
          notes: notes.concat(upstream.declared ? [] : ['upstream[] 未声明：refStale 一律为 null，表示**未回答**，不是「不失效」。']),
        }
      },
    },
    {
      name: 'ref_check',
      description: '逐个检查跨域 ref：形状是否可消费、由哪个上游域产出、是否仍在 upstream[] 的产出集合里（失效链接）。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: '要检查的 ref（可省略：检查语料里出现的全部 ref）' },
          path: { type: 'string', description: '追踪图文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 200, maxItems: 100, maxBytes: 65_536, maxCalls: 10 },
      execute(args) {
        const wanted = typeof args?.ref === 'string' && args.ref !== '' ? args.ref : null
        const documents = corpusFrom(args)
        const scoped = scopeOf(documents, args?.path)
        const upstream = upstreamSet(scoped)
        const items = []
        let truncated = false
        let seen = 0
        for (const document of scoped) {
          for (const node of Array.isArray(document.payload.nodes) ? document.payload.nodes : []) {
            const facts = nodeFacts(node)
            if (facts.ref === null) continue
            if (wanted !== null && facts.ref !== wanted) continue
            seen += 1
            if (items.length >= 100) { truncated = true; break }
            items.push({
              path: document.path,
              nodeId: node?.id ?? null,
              nodeType: typeof node?.type === 'string' ? node.type : null,
              ref: facts.ref,
              consumable: facts.shape !== null,
              refDomain: facts.shape?.domain ?? null,
              refForm: facts.shape?.form ?? null,
              // `exact` = the shape names one domain; `form` = it names a FAMILY.
              // Without this, `refDomain` for a `.ts` path reads as a fact.
              refBasis: facts.shape?.basis ?? null,
              upstreamDeclared: upstream.declared,
              inUpstream: upstream.declared ? upstream.refs.has(facts.ref) : null,
              stale: facts.shape !== null && upstream.declared ? !upstream.refs.has(facts.ref) : null,
            })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 张图 / 检查 ${seen} 个 ref，列出 ${items.length} 条；upstream 声明：${upstream.declared ? `有（${upstream.refs.size} 个）` : '**无**'}`,
          notes: [
            truncated ? 'ref 条数达到 maxItems=100，结果已截断' : '',
            upstream.declared
              ? ''
              : 'upstream[] 未声明：inUpstream / stale 一律为 null —— 这是**未回答**，不是「有效」。只确认了形状可消费。',
          ].filter((note) => note !== ''),
        }
      },
    },
  ],
})

/** Re-exported for this domain's tests and for callers that clip their own text. */
export { clipLines }
