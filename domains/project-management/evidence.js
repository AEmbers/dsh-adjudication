/**
 * project-management — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT THESE ARE FOR
 * ------------------
 * A bounded reviewer needs to ask questions OF THE GRAPH, and the only thing it
 * may not have is unlimited access. Each tool declares `limits`;
 * `normaliseEvidenceLimits` clamps it to the contract's ceilings, and the engine
 * refuses to register a tool that declares none. Every result carries
 * `{ items, truncated, provenance }` — a result that was cut short says so.
 *
 * Five questions cover what a plan reviewer can ask without inventing context:
 *
 *   graph_edges      what edges does this plan declare?           (bounded listing)
 *   task_neighbours  what does this task block / wait on?         (both directions)
 *   task_record      what do we know about this task?             (bounded body)
 *   cycle_paths      is there a cycle through these nodes?        (bounded DFS)
 *   risk_entries     which risks lack a real mitigation?          (bounded listing)
 *
 * WHY THESE READ `args.corpus` AND NOT FILES
 * ------------------------------------------
 * The caller injects the graph documents. This package has zero runtime imports
 * and an evidence tool that reached for `node:fs` would break that on the first
 * host that links the plugin instead of installing it. It also means the tools
 * answer about the SAME corpus the anchor verifier sees: a tool that re-read the
 * filesystem could confirm a claim about a plan the verifier never saw.
 *
 * THE ONE ASYMMETRY, STATED
 * -------------------------
 * `cycle_paths` runs a depth-first search, and a DFS is the obvious way to turn a
 * small tool into an unbounded one. Both bounds (`maxDepth`, `maxPaths`) are
 * declared in `parameters` and reported in `provenance`, and hitting either sets
 * `truncated: true`. A caller that gets `truncated: true` has learned that the
 * absence of a cycle in `items` is NOT evidence of acyclicity, which is exactly
 * the inference the flag exists to block.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'
import { adjacency, isOrphan, reachableFrom, simplePaths, slash } from '../_lib/graph.js'
import { taskEdgePairs, declaredIds } from './source.js'

const CORPUS_SCHEMA = {
  type: 'array',
  description: '任务图语料：[{ path, type?, payload: { tasks, idSpace?, risks?, milestones? }, meta? }]。必须由调用方注入；工具自身不读文件系统。',
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
 * A bare `{ tasks: [...] }` is what a caller naturally has when the plan is one
 * document with no meta. Rejecting it would push every such caller into wrapping
 * it by hand, and the wrapping is pure ceremony.
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
    if (Array.isArray(entry.tasks)) {
      documents.push({ path: slash(entry.path ?? `corpus/${index}/plan.json`), type: 'task-graph', payload: entry, meta: entry.meta ?? {} })
      continue
    }
    if (entry.payload !== null && typeof entry.payload === 'object') {
      documents.push({ path: slash(entry.path ?? `corpus/${index}/plan.json`), type: entry.type ?? 'task-graph', payload: entry.payload, meta: entry.meta ?? {} })
    }
  }
  if (documents.length === 0) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'corpus 里没有可读的任务图文档（需要 path + payload.tasks）')
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
    `语料里没有任务图 "${wanted}"。可比对的有：${documents.map((document) => document.path).join(', ')}`)
}

/** A short, deterministic `id (title)` label. */
const label = (task) => (task?.title ? `${task.id}（${task.title}）` : String(task?.id ?? '(无 id)'))

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'graph_edges',
      description: '列出任务图上声明的依赖边（from → to）。条数有硬上限，超出即截断并在 truncated 里说明。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '任务图文档路径（可省略，省略则列出全部语料）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 200, maxItems: 100, maxBytes: 65_536, maxCalls: 10 },
      execute(args) {
        const documents = corpusFrom(args)
        const scoped = args.path === undefined || args.path === null ? documents : [resolveDocument(documents, args.path)]
        const items = []
        let truncated = false
        let scanned = 0
        for (const document of scoped) {
          for (const [from, to, kind] of taskEdgePairs(document)) {
            scanned += 1
            if (items.length >= 100) { truncated = true; break }
            items.push({ path: document.path, from, to, kind })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 张图 / 扫过 ${scanned} 条边，列出 ${items.length} 条`,
          notes: truncated ? ['边数达到 maxItems=100，结果已截断 —— 未列出的边不代表不存在'] : [],
        }
      },
    },
    {
      name: 'task_neighbours',
      description: '某任务在图上的双向邻居：它等待谁（dependsOn）、谁等待它（dependents）。同时给出是否孤儿。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 ID' },
          path: { type: 'string', description: '任务图文档路径（可省略：会在全部语料里查找该 ID）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['taskId', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 120, maxItems: 60, maxBytes: 65_536, maxCalls: 12 },
      execute(args) {
        const taskId = String(args?.taskId ?? '')
        if (taskId === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`taskId` 不能为空')
        const documents = corpusFrom(args)
        const scoped = args.path === undefined || args.path === null ? documents : [resolveDocument(documents, args.path)]
        const items = []
        const notes = []
        for (const document of scoped) {
          const graph = adjacency([document], (doc) => taskEdgePairs(doc))
          // A task declared with no edges is invisible to `adjacency`. Seeding the
          // declared ids first is what lets `task_neighbours` answer "T9 has no
          // neighbours" instead of failing with "no such task" — and an orphan that
          // cannot be looked up is an orphan the reviewer can never confirm.
          for (const id of declaredIds(document)) {
            if (!graph.has(id)) graph.set(id, { from: null, to: null, out: [], in: [] })
          }
          const node = graph.get(taskId)
          if (node === undefined) continue
          if (items.length >= 60) { notes.push('邻居数达到 maxItems=60，结果已截断'); break }
          items.push({
            path: document.path,
            taskId,
            dependsOn: node.out,
            dependents: node.in,
            orphan: isOrphan(node),
          })
        }
        if (items.length === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `语料里没有任务 "${taskId}"。它可能是被依赖但未登记的外部 ID —— 这正是 unknownTarget 要暴露的情况，请先确认它在不在 idSpace 里。`)
        }
        return {
          items,
          truncated: notes.length > 0,
          provenance: `${scoped.length} 张图，命中 ${items.length} 处；taskId=${taskId}`,
          notes,
        }
      },
    },
    {
      name: 'task_record',
      description: '读某任务的登记内容（负责人、估算、状态、前置、说明）。正文有行数上限，超出即截断。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务 ID' },
          path: { type: 'string', description: '任务图文档路径（可省略：会在全部语料里查找该 ID）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['taskId', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 60, maxItems: 4, maxBytes: 32_768, maxCalls: 10 },
      execute(args) {
        const taskId = String(args?.taskId ?? '')
        if (taskId === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`taskId` 不能为空')
        const documents = corpusFrom(args)
        const scoped = args.path === undefined || args.path === null ? documents : [resolveDocument(documents, args.path)]
        const items = []
        let truncated = false
        for (const document of scoped) {
          const tasks = Array.isArray(document.payload.tasks) ? document.payload.tasks : []
          const task = tasks.find((entry) => entry?.id === taskId)
          if (task === undefined) continue
          if (items.length >= 4) { truncated = true; break }
          const body = typeof task.body === 'string' ? task.body : ''
          const lines = body.split(/\r?\n/u)
          const clipped = lines.length > 60
          if (clipped) truncated = true
          items.push({
            path: document.path,
            taskId,
            title: task.title ?? null,
            owner: task.owner ?? null,
            status: task.status ?? null,
            estimateDays: Number.isFinite(Number(task.estimateDays)) ? Number(task.estimateDays) : null,
            dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
            body: clipped ? lines.slice(0, 60).join('\n') : body,
            inIdSpace: (Array.isArray(document.payload.idSpace) ? document.payload.idSpace : []).includes(taskId),
          })
        }
        if (items.length === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `语料里没有任务记录 "${taskId}"。若它只在 dependsOn 里出现过，说明它是**未登记的依赖目标** —— 那是一条发现，不是一个可以补全的查询。`)
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 张图，命中 ${items.length} 条记录；正文上限 60 行`,
          notes: truncated ? ['正文或记录数达到上限，结果已截断'] : [],
        }
      },
    },
    {
      name: 'cycle_paths',
      description: '在图上深度优先搜索 from 到 to 的简单路径（有界：maxDepth / maxPaths）。返回的全部路径条数即为「该回路是否唯一」的证据。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '起点任务 ID' },
          to: { type: 'string', description: '终点任务 ID（回路时填起点自己）' },
          maxDepth: { type: 'integer', description: '最大搜索深度，默认 8，硬上限 12' },
          maxPaths: { type: 'integer', description: '最多返回路径条数，默认 12，硬上限 24' },
          path: { type: 'string', description: '任务图文档路径（可省略）' },
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
        const maxDepth = Math.min(Math.max(1, Number(args.maxDepth) || 8), 12)
        const maxPaths = Math.min(Math.max(1, Number(args.maxPaths) || 12), 24)
        const documents = corpusFrom(args)
        const scoped = args.path === undefined || args.path === null ? documents : [resolveDocument(documents, args.path)]
        const items = []
        let truncated = false
        for (const document of scoped) {
          const edges = taskEdgePairs(document).map(([a, b]) => [a, b])
          const found = simplePaths(from, to, edges, { maxDepth, maxPaths })
          if (found.truncated) truncated = true
          for (const path of found.paths) items.push({ path: document.path, route: path })
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 张图；from=${from} to=${to}；深度上限 ${maxDepth}，路径上限 ${maxPaths}；命中 ${items.length} 条`,
          notes: truncated
            ? ['搜索触到深度或路径上限：items 里没有回路**不构成**无环的证据，请提高上限或改用更小的子图重问']
            : [],
        }
      },
    },
    {
      name: 'risk_entries',
      description: '列出台账里的风险条目，标出哪些没有实质应对措施（「待观察」「持续跟进」不算）。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '任务图文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 160, maxItems: 80, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const documents = corpusFrom(args)
        const scoped = args.path === undefined || args.path === null ? documents : [resolveDocument(documents, args.path)]
        const items = []
        let truncated = false
        for (const document of scoped) {
          const risks = Array.isArray(document.payload.risks) ? document.payload.risks : []
          for (const risk of risks) {
            if (items.length >= 80) { truncated = true; break }
            items.push({
              path: document.path,
              riskId: risk?.id ?? null,
              trigger: risk?.trigger ?? null,
              impact: risk?.impact ?? null,
              mitigation: risk?.mitigation ?? null,
              mitigationMissing: !(typeof risk?.mitigation === 'string' && risk.mitigation.trim() !== ''),
              owners: Array.isArray(risk?.owners) ? risk.owners : [],
            })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 张图，列出 ${items.length} 条风险`,
          notes: truncated ? ['风险条数达到 maxItems=80，结果已截断'] : [],
        }
      },
    },
  ],
})

/** Re-exported for the domain's tests: the bounded reachability primitive. */
export { reachableFrom, label as taskLabel }
