/**
 * code-review — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT THESE ARE FOR
 * ------------------
 * A bounded reviewer needs to look at the code it is judging, and the only
 * thing it may not have is unlimited access. Each tool below declares a
 * `limits` object; `normaliseEvidenceLimits` clamps it to the contract's hard
 * ceilings, and the engine refuses to register a tool that declares none. Every
 * result carries `{ items, truncated, provenance }` — a result that was cut
 * short says so instead of quietly returning less.
 *
 * The three tools answer the only three questions a diff reviewer can ask
 * without inventing context:
 *
 *   read_lines     what is at these lines of this file?
 *   search_diff    where does this text appear in the changed files?
 *   enclosing      what function/scope contains this line? (bounded indentation walk)
 *
 * All three read from content the CALLER injects through `args.documents`. They
 * touch no filesystem: this package has zero runtime imports, and an evidence
 * tool that reached for `node:fs` would break that on the first host that links
 * the plugin instead of installing it.
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

/** Read `documents` off the call, rejecting anything else loudly. */
function documentsFrom(args) {
  const raw = args?.documents
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `documents`：[{ path, content }]。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({ path: entry.path, content: typeof entry.content === 'string' ? entry.content : '' }))
}

function splitLines(content) {
  return String(content).split(/\r?\n/u)
}

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
      name: 'read_lines',
      description: '读取某个变更文件的指定行区间。行数有硬上限，超出即截断并在 truncated 里说明。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（可写后缀，须在文档集里唯一）' },
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
      name: 'search_diff',
      description: '在变更文件里检索一段文字（子串，区分大小写），返回命中处的路径与行号。命中条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要检索的字面文字（不是正则）' },
          path: { type: 'string', description: '限定在某个文件内（可省略）' },
          documents: DOCUMENTS_SCHEMA,
        },
        required: ['pattern', 'documents'],
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
        if (needle === '') {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`pattern` 不能为空')
        }
        const documents = documentsFrom(args)
        const scoped = args.path === undefined || args.path === null
          ? documents
          : [resolveDocument(documents, args.path)]
        const items = []
        let truncated = false
        let scanned = 0
        for (const document of scoped) {
          const lines = splitLines(document.content)
          for (let index = 0; index < lines.length; index += 1) {
            scanned += 1
            if (!lines[index].includes(needle)) continue
            if (items.length >= 100) { truncated = true; break }
            items.push({ path: document.path, line: index + 1, text: lines[index] })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 个文件 / 扫过 ${scanned} 行，命中 ${items.length} 处`,
          notes: truncated ? ['命中数达到 maxItems=100，结果已截断'] : [],
        }
      },
    },
    {
      name: 'enclosing',
      description: '找出包含目标行的最外层语句块起点：按缩进向上回溯到第一个缩进更小的非空行。这是启发式，返回值里会说明回溯了多少行。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          line: { type: 'integer', description: '目标行（1-based）' },
          documents: DOCUMENTS_SCHEMA,
        },
        required: ['path', 'line', 'documents'],
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
      limits: { maxLines: 40, maxItems: 16, maxBytes: 32_768, maxCalls: 6 },
      execute(args) {
        const documents = documentsFrom(args)
        const document = resolveDocument(documents, args.path)
        const lines = splitLines(document.content)
        const target = Number.isInteger(args.line) && args.line >= 1 ? args.line : 1
        if (target > lines.length) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `第 ${target} 行超出 ${document.path}（共 ${lines.length} 行）`)
        }
        const indentOf = (text) => (/^[ \t]*/u.exec(text) ?? [''])[0].replace(/\t/gu, '    ').length

        // Walk UP to the first non-blank line whose indent is strictly smaller
        // than the target's. That line is the statement the target sits inside.
        // Bounded by 40 steps so a fully flat file costs a constant, not a scan.
        const own = indentOf(lines[target - 1])
        let start = target
        let steps = 0
        for (let number = target - 1; number >= 1 && steps < 40; number -= 1) {
          steps += 1
          const text = lines[number - 1]
          if (text.trim() === '') continue
          if (indentOf(text) < own) { start = number; break }
        }

        const items = []
        for (let number = start; number <= target && items.length < 16; number += 1) {
          items.push({ path: document.path, line: number, text: lines[number - 1] ?? '' })
        }
        const truncated = target - start + 1 > items.length
        return {
          items,
          truncated,
          provenance: `${document.path}:${start}-${target}（缩进回溯 ${steps} 行；启发式，非语法解析）`,
          notes: truncated ? ['上下文行数超过 maxItems=16，结果已截断'] : [],
        }
      },
    },
  ],
})
