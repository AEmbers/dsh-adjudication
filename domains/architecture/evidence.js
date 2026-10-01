/**
 * architecture — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT AN ARCHITECTURE REVIEWER ACTUALLY NEEDS TO LOOK AT
 * ------------------------------------------------------
 * Three questions, and nothing more:
 *
 *   module_edges  what does this module depend on, and what depends on it?
 *   graph_path    is there a path from A back to B (i.e. a cycle)?
 *   adr_lookup    what does the decision archive actually say?
 *
 * THE CONTEXT SHAPES ARE THE P0 SHAPES, ON PURPOSE
 * ------------------------------------------------
 * `modules`, `adrs` and `layers` are read in the SAME shapes the documented input
 * format uses (`module-graph-and-adr`), so a reviewer holding the P0 payload does
 * not have to translate it to call a tool:
 *
 *   modules: [{ id, path, dependsOn: string[], layer? }]
 *   adrs:    [{ id, title, status, decision, affects: string[] }]
 *   layers:  ['outer', …, 'inner']   (ordered; an edge must point outer -> inner)
 *
 * EVERY TOOL READS ONLY WHAT THE CALLER INJECTS. They touch no filesystem: this
 * package has zero runtime imports, and a tool that reached for `node:fs` would
 * break that on the first host that links the plugin instead of installing it.
 * A tool that cannot find what it needs says so; it never returns an empty result
 * that reads as "the graph says there is nothing here".
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

/** `id -> dependsOn[]`, restricted to edges whose target the manifest declares. */
function adjacencyOf(modules) {
  const known = new Set(modules.filter((module) => typeof module?.id === 'string').map((module) => module.id))
  const graph = new Map()
  for (const module of modules) {
    if (typeof module?.id !== 'string') continue
    graph.set(module.id, (Array.isArray(module.dependsOn) ? module.dependsOn : [])
      .filter((value) => typeof value === 'string' && value !== '' && known.has(value)))
  }
  return graph
}

function modulesFrom(args) {
  const raw = args?.modules
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `modules`：[{ id, path, dependsOn, layer? }]。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

function adrsFrom(args) {
  const raw = args?.adrs
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `adrs`：[{ id, title, status, decision, affects }]。没有决策归档就无法区分「没有决策」与「不知道」。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

/** The witness path for a cycle, bounded. `null` when there is none. */
function findPath(graph, from, to, maxDepth = 64) {
  if (from === to) return [from]
  const queue = [[from]]
  const seen = new Set([from])
  while (queue.length > 0) {
    const path = queue.shift()
    if (path.length > maxDepth) return null
    for (const next of graph.get(path[path.length - 1]) ?? []) {
      if (next === to) return [...path, next]
      if (seen.has(next)) continue
      seen.add(next)
      queue.push([...path, next])
    }
  }
  return null
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'module_edges',
      description: '列出某个模块（或全部模块）的出边与入边，并标注每条边的层次方向。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          moduleId: { type: 'string', description: '只看这个模块（可省略 = 全部）' },
          direction: { type: 'string', enum: ['both', 'out', 'in'], description: '方向，默认 both' },
          modules: {
            type: 'array',
            description: '模块依赖图（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
          layers: {
            type: 'array',
            description: '有序层次声明（外层在前），用于标注方向',
            items: { type: 'string' },
          },
        },
        required: ['modules'],
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
      limits: { maxLines: 200, maxItems: 60, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const modules = modulesFrom(args)
        const layers = Array.isArray(args.layers) ? args.layers : null
        const rank = (layer) => (layers === null ? null : layers.indexOf(layer))
        const wanted = typeof args.moduleId === 'string' && args.moduleId !== '' ? args.moduleId : null
        const direction = ['both', 'out', 'in'].includes(args.direction) ? args.direction : 'both'
        const byId = new Map(modules.filter((module) => typeof module.id === 'string').map((module) => [module.id, module]))

        const items = []
        let truncated = false
        let scanned = 0
        const push = (edge) => {
          scanned += 1
          if (items.length >= 60) { truncated = true; return }
          items.push(edge)
        }

        for (const module of byId.values()) {
          if (wanted !== null && module.id !== wanted) continue
          if (direction !== 'in') {
            for (const targetId of Array.isArray(module.dependsOn) ? module.dependsOn : []) {
              const target = byId.get(targetId)
              const fromRank = layers === null ? null : rank(module.layer)
              const toRank = layers === null || target === undefined ? null : rank(target.layer)
              push({
                direction: 'out',
                from: module.id,
                to: targetId,
                declared: target !== undefined,
                fromLayer: module.layer ?? null,
                toLayer: target?.layer ?? null,
                reverse: fromRank === null || toRank === null ? null : fromRank > toRank,
              })
            }
          }
          if (direction !== 'out') {
            for (const other of byId.values()) {
              if (!(Array.isArray(other.dependsOn) && other.dependsOn.includes(module.id))) continue
              push({
                direction: 'in',
                from: other.id,
                to: module.id,
                declared: true,
                fromLayer: other.layer ?? null,
                toLayer: module.layer ?? null,
                reverse: null,
              })
            }
          }
        }
        return {
          items,
          truncated,
          provenance: `扫过 ${byId.size} 个模块${wanted === null ? '' : `，只看 "${wanted}"`}，返回 ${items.length} 条边${layers === null ? '（未提供 layers，方向未标注）' : ''}`,
          notes: truncated ? ['边数达到 maxItems=60，结果已截断'] : [],
        }
      },
    },
    {
      name: 'graph_path',
      description: '在依赖图里找一条从 from 到 to 的有向路径（用于验证环依赖或可达性）。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点模块 ID' },
          to: { type: 'string', description: '终点模块 ID' },
          modules: {
            type: 'array',
            description: '模块依赖图（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['from', 'to', 'modules'],
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
      limits: { maxLines: 200, maxItems: 64, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const modules = modulesFrom(args)
        const from = String(args?.from ?? '')
        const to = String(args?.to ?? '')
        if (from === '' || to === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`from` 与 `to` 都不能为空')
        const graph = adjacencyOf(modules)
        if (!graph.has(from)) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `依赖图里没有模块 "${from}"。图中有：${[...graph.keys()].join(', ') || '(空)'}`)
        }
        const path = findPath(graph, from, to)
        const items = path === null
          ? []
          : path.slice(0, 63).map((id, index) => ({ step: index, moduleId: id }))
        return {
          items,
          truncated: path !== null && path.length > 63,
          provenance: path === null
            ? `依赖图里没有从 "${from}" 到 "${to}" 的有向路径`
            : `找到路径：${path.join(' → ')}`,
          notes: path === null ? ['没有路径本身就是一个结论：该可达性主张在图上不成立'] : [],
        }
      },
    },
    {
      name: 'adr_lookup',
      description: '按 ID（或状态）查 ADR 归档，返回决策文本、状态与它声明影响的模块。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ADR ID（精确匹配优先，否则按子串）' },
          status: { type: 'string', description: '按状态过滤（可省略）' },
          adrs: {
            type: 'array',
            description: 'ADR 归档（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['adrs'],
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
      limits: { maxLines: 200, maxItems: 40, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const adrs = adrsFrom(args)
        const wanted = typeof args.id === 'string' && args.id !== '' ? args.id : null
        const wantedStatus = typeof args.status === 'string' && args.status !== '' ? args.status : null
        const exact = wanted === null ? [] : adrs.filter((adr) => adr.id === wanted)
        const matches = wanted === null
          ? adrs
          : (exact.length > 0 ? exact : adrs.filter((adr) => typeof adr.id === 'string' && adr.id.includes(wanted)))
        const items = []
        let truncated = false
        for (const adr of matches) {
          if (wantedStatus !== null && adr.status !== wantedStatus) continue
          if (items.length >= 40) { truncated = true; break }
          items.push({
            id: adr.id ?? null,
            title: adr.title ?? null,
            status: adr.status ?? null,
            decision: adr.decision ?? null,
            affects: Array.isArray(adr.affects) ? adr.affects : [],
          })
        }
        return {
          items,
          truncated,
          provenance: `在 ${adrs.length} 条 ADR 中${wanted === null ? '全量' : `按 "${wanted}"`}${wantedStatus === null ? '' : `、状态 "${wantedStatus}"`}命中 ${items.length} 条`,
          notes: truncated ? ['命中数达到 maxItems=40，结果已截断'] : [],
        }
      },
    },
  ],
})
