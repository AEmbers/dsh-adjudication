/**
 * data-engineering — P7 evidence tools (contract v2, extension point 3).
 *
 * Each tool declares `limits`; `normaliseEvidenceLimits` clamps them to the
 * contract's hard ceilings, and the engine refuses to register a tool that
 * declares none. Every result is `{ items, truncated, provenance }` — a result
 * that was cut short says so instead of quietly returning less.
 *
 * The three tools answer the three questions a lineage reviewer can actually
 * ask without inventing context:
 *
 *   lineage_walk        what is this node connected to, up to N hops?
 *   node_sql_excerpt    what does this node's SQL say at these lines?
 *   column_contract     what is this table's column contract in the warehouse?
 *
 * All three read ONLY what the caller injects through `args` (`lineage`,
 * `schema`, `documents`). They touch no filesystem: this package has zero
 * runtime imports, and a tool that reached for `node:fs` would break that on the
 * first host that links the plugin instead of installing it.
 *
 * WHY A TOOL THAT WALKS THE GRAPH MATTERS HERE: the bounded reviewer is
 * forbidden to assert an edge it has not confirmed (see `anchor.js`). A tool
 * that returns the node's real neighbourhood is how it checks that affordably,
 * instead of guessing from SQL it happens to have seen.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'
import { lineageEdges } from './source.js'

const LINEAGE_SCHEMA = {
  type: 'object',
  description: '血缘图：{ nodes: [{ id, inputs, outputs }], schema? }。必须由调用方注入；工具自身不读文件系统。',
  additionalProperties: true,
  properties: { nodes: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  required: ['nodes'],
}

function nodesFrom(args) {
  const raw = args?.lineage
  const nodes = Array.isArray(raw) ? raw : raw?.nodes
  if (!Array.isArray(nodes)) {
    throw contractError(
      ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `lineage`（{ nodes: [...] }）。取证工具不接受空上下文，否则它只会不断地报「找不到」。',
    )
  }
  return nodes
}

function documentsFrom(args) {
  const raw = args?.documents
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `documents`：[{ path, content }]。')
  }
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, content: typeof entry.content === 'string' ? entry.content : '' }))
}

/** The path a request names, or a loud failure — defaulting would hide a typo. */
function resolveDocument(documents, path) {
  const wanted = String(path ?? '')
  const exact = documents.find((document) => document.path === wanted)
  if (exact !== undefined) return exact
  const suffix = documents.find((document) => document.path.endsWith(wanted))
  if (suffix !== undefined && wanted !== '') return suffix
  throw contractError(
    ERROR_CODES.E_INPUT_FORMAT,
    `文档集里没有 "${wanted}"。可比对的有：${documents.map((document) => document.path).join(', ') || '(空)'}`,
  )
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'lineage_walk',
      description: '从某个节点出发按血缘边向外走 N 跳（默认 1），返回所见的边。跳数与条数都有硬上限，超出即截断。',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: '起点节点 id' },
          depth: { type: 'integer', description: '向外走几跳（默认 1，上限 3）' },
          lineage: LINEAGE_SCHEMA,
        },
        required: ['nodeId', 'lineage'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 40, maxItems: 40, maxBytes: 32_768, maxCalls: 6 },
      execute(args) {
        const nodes = nodesFrom(args)
        const start = String(args?.nodeId ?? '')
        if (start === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`nodeId` 不能为空')
        const depth = Math.max(1, Math.min(Number.isInteger(args?.depth) ? args.depth : 1, 3))
        const edges = lineageEdges(nodes)
        const frontier = [start]
        const seen = new Set([start])
        const items = []
        let truncated = false
        for (let hop = 1; hop <= depth; hop += 1) {
          const next = []
          for (const id of frontier) {
            for (const edge of edges) {
              if (edge.nodeId !== id) continue
              if (items.length >= 40) { truncated = true; break }
              items.push({ hop, nodeId: edge.nodeId, from: edge.from, to: edge.to, direction: edge.direction })
              const neighbour = edge.from === id ? edge.to : edge.from
              if (!seen.has(neighbour)) { seen.add(neighbour); next.push(neighbour) }
            }
            if (truncated) break
          }
          if (truncated) break
          if (next.length === 0) break
          frontier.length = 0
          frontier.push(...next)
        }
        return {
          items,
          truncated,
          provenance: `lineage ${nodes.length} 个节点 / ${edges.length} 条边，从 "${start}" 走 ${depth} 跳，见 ${items.length} 条边`,
          notes: truncated ? ['边数达到 maxItems=40，结果已截断'] : [],
        }
      },
    },
    {
      name: 'node_sql_excerpt',
      description: '读取某个节点 SQL 文档的指定行区间。行数有硬上限，超出即截断并在 truncated 里说明。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '节点 SQL 的路径（可写后缀，须在文档集里唯一）' },
          start: { type: 'integer', description: '起始行（1-based，默认 1）' },
          end: { type: 'integer', description: '结束行（含，默认 start + 上限 - 1）' },
          documents: {
            type: 'array',
            description: '可比对文档：[{ path, content }]。',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
        },
        required: ['path', 'documents'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 120, maxItems: 120, maxBytes: 65_536, maxCalls: 10 },
      execute(args) {
        const documents = documentsFrom(args)
        const document = resolveDocument(documents, args.path)
        const lines = String(document.content).split(/\r?\n/u)
        const start = Number.isInteger(args.start) && args.start >= 1 ? args.start : 1
        const requestedEnd = Number.isInteger(args.end) && args.end >= start ? args.end : lines.length
        const end = Math.min(requestedEnd, start + 120 - 1, lines.length)
        const items = []
        for (let number = start; number <= end; number += 1) {
          items.push({ path: document.path, line: number, text: lines[number - 1] ?? '' })
        }
        const truncated = requestedEnd > end
        return {
          items,
          truncated,
          provenance: `${document.path}:${start}-${end}（共 ${lines.length} 行）`,
          notes: truncated ? [`请求到第 ${requestedEnd} 行，按 maxLines=120 截断在第 ${end} 行`] : [],
        }
      },
    },
    {
      name: 'column_contract',
      description: '查一张表在仓库 schema 里的字段契约（名字、类型、是否可空）。条数有硬上限，超出即截断。',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: '表名，如 analytics.orders_daily' },
          column: { type: 'string', description: '只看某个字段（可省略）' },
          lineage: LINEAGE_SCHEMA,
        },
        required: ['table', 'lineage'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 60, maxItems: 60, maxBytes: 32_768, maxCalls: 8 },
      execute(args) {
        const nodes = nodesFrom(args)
        const raw = Array.isArray(args?.lineage) ? args.lineage : args?.lineage?.schema
        const table = String(args?.table ?? '')
        if (table === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`table` 不能为空')
        const declared = raw?.[table]
        const columns = Array.isArray(declared?.columns) ? declared.columns : []
        if (columns.length === 0) {
          const known = raw !== null && typeof raw === 'object' ? Object.keys(raw).join(', ') : '(未注入 schema)'
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `schema 里没有 "${table}" 的列定义。已知的表：${known || '(空)'}`)
        }
        const wanted = typeof args?.column === 'string' && args.column !== '' ? args.column : null
        const items = []
        let truncated = false
        for (const entry of columns) {
          const name = String(entry?.name ?? '')
          if (wanted !== null && name !== wanted) continue
          if (items.length >= 60) { truncated = true; break }
          items.push({ table, column: name, type: String(entry?.type ?? 'unknown'), nullable: entry?.nullable === true, default: entry?.default ?? null })
        }
        return {
          items,
          truncated,
          provenance: `schema["${table}"] ${columns.length} 个字段（血缘图 ${nodes.length} 个节点），返回 ${items.length} 条`,
          notes: truncated ? ['字段数达到 maxItems=60，结果已截断'] : [],
        }
      },
    },
  ],
})
