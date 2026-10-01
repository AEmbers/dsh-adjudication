/**
 * risk-compliance — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT THESE ARE FOR
 * ------------------
 * A compliance reviewer must be able to check the two halves of its own claim:
 * "does this clause really say that" (the RULE side) and "does the surface
 * really look like that" (the EVIDENCE side). Each tool below declares `limits`;
 * `normaliseEvidenceLimits` clamps them to the contract's hard ceilings, and
 * every result carries `{ items, truncated, provenance }` — a cut-short result
 * says so instead of quietly returning less.
 *
 * The three tools answer the only three questions this domain can ask without
 * inventing material:
 *
 *   read_surface    what does this regulated surface actually look like?
 *   search_clauses  which clause says something about X? (the rule side)
 *   list_bindings   which (clause, surface) bindings are actually enumerated?
 *
 * All three read content the CALLER injects through `args`. They touch no
 * filesystem: this package has zero runtime imports, and an evidence tool that
 * reached for `node:fs` would break that on the first host that links the plugin
 * instead of installing it.
 *
 * A missing context is refused LOUDLY rather than answered with "nothing
 * found": "I searched nothing and found nothing" is the single most misleading
 * result a compliance tool can return.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

const DOCUMENTS_SCHEMA = {
  type: 'array',
  description: '可比对文档：[{ path, content }]。内容必须由调用方注入；工具自身不读文件系统。',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
}

const CLAUSES_SCHEMA = {
  type: 'array',
  description: '条款清单：[{ id, title, text }]。',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: { id: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } },
    required: ['id'],
  },
}

function documentsFrom(args) {
  const raw = args?.documents
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `documents`：[{ path, content }]。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, content: typeof entry.content === 'string' ? entry.content : '' }))
}

function clausesFrom(args) {
  const raw = args?.clauses
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `clauses`：[{ id, title, text }]。没有条款清单时，规则侧锚点无法重算 —— 此时应判未锚定，而不是猜。')
  }
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
    .map((entry) => ({ id: entry.id, title: entry.title ?? null, text: typeof entry.text === 'string' ? entry.text : '' }))
}

const splitLines = (content) => String(content).split(/\r?\n/u)

/** The path a request names, or a loud failure — silently defaulting would hide a wrong path. */
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
      name: 'read_surface',
      description: '读取某个受监管面的证据文本的指定行区间。行数有硬上限，超出即截断并在 truncated 里说明。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '受监管面路径（可写后缀，须在文档集里唯一）' },
          start: { type: 'integer', description: '起始行（1-based，默认 1）' },
          end: { type: 'integer', description: '结束行（含，默认 start + 上限 - 1）' },
          documents: DOCUMENTS_SCHEMA,
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
      limits: { maxLines: 120, maxItems: 120, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const documents = documentsFrom(args)
        const document = resolveDocument(documents, args.path)
        const lines = splitLines(document.content)
        const start = Number.isInteger(args.start) && args.start >= 1 ? args.start : 1
        const requestedEnd = Number.isInteger(args.end) && args.end >= start ? args.end : lines.length
        const cap = start + 120 - 1
        const end = Math.min(requestedEnd, cap, lines.length)
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
      name: 'search_clauses',
      description: '在条款清单里检索一段文字（子串，区分大小写），返回命中的条款 id 与标题。命中条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要检索的字面文字（不是正则）' },
          clauses: CLAUSES_SCHEMA,
        },
        required: ['pattern', 'clauses'],
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
      limits: { maxLines: 200, maxItems: 100, maxBytes: 65_536, maxCalls: 10 },
      execute(args) {
        const needle = String(args?.pattern ?? '')
        if (needle === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`pattern` 不能为空')
        const clauses = clausesFrom(args)
        const items = []
        let truncated = false
        let scanned = 0
        for (const clause of clauses) {
          scanned += 1
          const haystack = `${clause.id}\n${clause.title ?? ''}\n${clause.text}`
          if (!haystack.includes(needle)) continue
          if (items.length >= 100) { truncated = true; break }
          const line = String(clause.text).split(/\r?\n/u).findIndex((text) => text.includes(needle)) + 1
          items.push({ id: clause.id, title: clause.title, line: line === 0 ? null : line, text: clause.text.slice(0, 400) })
        }
        return {
          items,
          truncated,
          provenance: `扫过 ${scanned} 条条款，命中 ${items.length} 条（字面子串匹配，非语义检索）`,
          notes: truncated ? ['命中数达到 maxItems=100，结果已截断'] : [],
        }
      },
    },
    {
      name: 'list_bindings',
      description: '列出 P0 实际枚举出的 (条款, 受监管面) 绑定。用于核对一条发现声称的绑定是否真的在候选集里。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          clauseId: { type: 'string', description: '只列某个条款名下的绑定（可省略）' },
          candidates: {
            type: 'array',
            description: 'P0 的候选集：每项 { id, path, locator, meta }。',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['candidates'],
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
      limits: { maxLines: 60, maxItems: 80, maxBytes: 65_536, maxCalls: 6 },
      execute(args) {
        const raw = args?.candidates
        if (!Array.isArray(raw)) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `candidates`：没有候选集就无法回答「这个绑定是枚举出来的还是编出来的」。')
        }
        const wanted = typeof args.clauseId === 'string' && args.clauseId !== '' ? args.clauseId : null
        const items = []
        let truncated = false
        for (const candidate of raw) {
          if (candidate === null || typeof candidate !== 'object') continue
          const clauseId = candidate?.meta?.clauseId ?? candidate?.locator?.clauseId ?? null
          const surfaceId = candidate?.meta?.surfaceId ?? candidate?.locator?.surfaceId ?? null
          if (typeof clauseId !== 'string' || typeof surfaceId !== 'string') continue
          if (wanted !== null && clauseId !== wanted) continue
          if (items.length >= 80) { truncated = true; break }
          items.push({ clauseId, surfaceId, path: String(candidate.path ?? '') })
        }
        return {
          items,
          truncated,
          provenance: `候选集 ${raw.length} 项${wanted === null ? '' : `，过滤 clauseId=${wanted}`}，绑定 ${items.length} 条`,
          notes: truncated ? ['绑定数达到 maxItems=80，结果已截断'] : [],
        }
      },
    },
  ],
})
