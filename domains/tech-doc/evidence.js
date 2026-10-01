/**
 * tech-doc — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT A DOCUMENTATION-CONSISTENCY REVIEWER ACTUALLY NEEDS TO LOOK AT
 * ------------------------------------------------------------------
 * Three questions, and nothing more:
 *
 *   read_section   what does this paragraph actually say?
 *   api_lookup     what does the API surface actually declare?
 *   search_docs    where else is this claimed?
 *
 * THE CONTEXT SHAPES ARE THE P0 SHAPES, ON PURPOSE
 * ------------------------------------------------
 * `documents` and `api` are read in the SAME shapes the documented input format
 * uses (`doc-corpus-and-api-surface`), so a reviewer holding the P0 payload does
 * not have to translate it to call a tool:
 *
 *   documents: [{ path, title, sections: [{ anchor, text }] }]
 *   api:       [{ name, signature, params: [{ name, required, default? }], returns }]
 *
 * EVERY TOOL READS ONLY WHAT THE CALLER INJECTS. They touch no filesystem: this
 * package has zero runtime imports, and a tool that reached for `node:fs` would
 * break that on the first host that links the plugin instead of installing it.
 * A tool that cannot find what it needs says so; it never returns an empty
 * result that reads as "there is nothing here".
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

function documentsFrom(args) {
  const raw = args?.documents
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `documents`：[{ path, title?, sections: [{ anchor, text }] }]。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({
      path: entry.path,
      title: typeof entry.title === 'string' ? entry.title : null,
      sections: (Array.isArray(entry.sections) ? entry.sections : [])
        .filter((section) => section !== null && typeof section === 'object')
        .map((section) => ({
          anchor: typeof section.anchor === 'string' ? section.anchor : '',
          text: typeof section.text === 'string' ? section.text : '',
        })),
    }))
}

function apiFrom(args) {
  const raw = args?.api
  if (raw === undefined || raw === null) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '缺少 `api`：[{ name, signature, params, returns }]。没有 API surface 就无法重算签名 —— 「无法核验」不是「一致」。')
  }
  if (Array.isArray(raw)) return raw.filter((entry) => entry !== null && typeof entry === 'object')
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([name, entry]) => (
      entry !== null && typeof entry === 'object' ? { name, ...entry } : { name, signature: String(entry) }
    ))
  }
  throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`api` 必须是数组或对象映射')
}

function resolveDocuments(documents, path) {
  const wanted = String(path ?? '')
  const exact = documents.find((entry) => entry.path === wanted)
  if (exact !== undefined) return [exact]
  const suffix = documents.filter((entry) => entry.path.endsWith(wanted))
  if (suffix.length > 0 && wanted !== '') return suffix
  throw contractError(
    ERROR_CODES.E_INPUT_FORMAT,
    `文档集里没有 "${wanted}"。可比对的有：${documents.map((entry) => entry.path).join(', ') || '(空)'}`,
  )
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'read_section',
      description: '读取某个文档段落的正文（或整篇文档的前 N 行），逐行返回。行数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文档路径（可写后缀，须在文档集里唯一）' },
          anchor: { type: 'string', description: '段落锚（标题锚）；省略则读取整篇' },
          start: { type: 'integer', description: '段落内起始行（1-based，默认 1）' },
          end: { type: 'integer', description: '段落内结束行（含，默认 start + 上限 - 1）' },
          documents: {
            type: 'array',
            description: '文档树：[{ path, title?, sections: [{ anchor, text }] }]（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
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
      limits: { maxLines: 80, maxItems: 80, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const documents = documentsFrom(args)
        const matches = resolveDocuments(documents, args.path)
        const wantedAnchor = typeof args.anchor === 'string' && args.anchor !== '' ? args.anchor : null
        const sections = wantedAnchor === null
          ? matches.flatMap((document) => document.sections.map((section) => ({ ...section, path: document.path })))
          : matches.flatMap((document) => document.sections
            .filter((section) => section.anchor === wantedAnchor)
            .map((section) => ({ ...section, path: document.path })))
        if (wantedAnchor !== null && sections.length === 0) {
          const available = matches.flatMap((document) => document.sections.map((section) => section.anchor))
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `文档 ${matches.map((document) => document.path).join(', ')} 里没有段落锚 "${wantedAnchor}"。实际有：${available.join(', ') || '(空)'}`)
        }

        const lines = sections.flatMap((section) => section.text.split(/\r?\n/u)
          .map((text, index) => ({ path: section.path, anchor: section.anchor, line: index + 1, text })))
        const start = Number.isInteger(args.start) && args.start >= 1 ? args.start : 1
        const requestedEnd = Number.isInteger(args.end) && args.end >= start ? args.end : lines.length
        const end = Math.min(requestedEnd, start + 79, lines.length)
        const items = lines.slice(start - 1, end)
        const truncated = requestedEnd > end
        return {
          items,
          truncated,
          provenance: `${matches.map((document) => document.path).join(', ')}${wantedAnchor === null ? '（整篇）' : `#${wantedAnchor}`}:${start}-${end}（共 ${lines.length} 行）`,
          notes: truncated ? [`请求到第 ${requestedEnd} 行，按 maxLines=80 截断在第 ${end} 行`] : [],
        }
      },
    },
    {
      name: 'api_lookup',
      description: '按名字（精确或子串）查 API surface，返回签名、参数表、返回值，以及文档里提到它的位置。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'API 名，精确匹配优先，否则按子串' },
          api: {
            type: 'array',
            description: 'API surface：[{ name, signature, params, returns }]（与 P0 同形）',
            items: { type: 'object', additionalProperties: true },
          },
          documents: {
            type: 'array',
            description: '文档树（用于回答「文档在哪儿讲过它」；可省略）',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['name', 'api'],
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
      limits: { maxLines: 120, maxItems: 20, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const wanted = String(args?.name ?? '')
        if (wanted === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`name` 不能为空')
        const api = apiFrom(args)
        const documents = Array.isArray(args.documents) ? args.documents : []
        const exact = api.filter((entry) => entry.name === wanted)
        const matches = exact.length > 0
          ? exact
          : api.filter((entry) => typeof entry.name === 'string' && entry.name.includes(wanted))
        const items = []
        let truncated = false
        for (const entry of matches) {
          if (items.length >= 20) { truncated = true; break }
          const mentionedIn = []
          for (const document of documents) {
            for (const section of Array.isArray(document?.sections) ? document.sections : []) {
              if (typeof section?.text === 'string' && section.text.includes(String(entry.name))) {
                mentionedIn.push(`${document.path}#${section.anchor}`)
              }
            }
          }
          items.push({
            name: entry.name ?? null,
            signature: entry.signature ?? null,
            params: Array.isArray(entry.params) ? entry.params : null,
            returns: entry.returns ?? null,
            mentionedIn,
          })
        }
        return {
          items,
          truncated,
          provenance: `在 ${api.length} 个 API 条目中按 "${wanted}" 命中 ${items.length} 个${exact.length > 0 ? '（精确）' : '（名称子串）'}`,
          notes: truncated ? ['命中数达到 maxItems=20，结果已截断'] : [],
        }
      },
    },
    {
      name: 'search_docs',
      description: '在文档树里按子串检索，返回逐行的命中位置。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要检索的子串（不是正则）' },
          documents: {
            type: 'array',
            description: '文档树：[{ path, title?, sections: [{ anchor, text }] }]',
            items: { type: 'object', additionalProperties: true },
          },
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
      limits: { maxLines: 60, maxItems: 60, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const pattern = String(args?.pattern ?? '')
        if (pattern === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`pattern` 不能为空')
        const documents = documentsFrom(args)
        const items = []
        let truncated = false
        let scanned = 0
        for (const document of documents) {
          for (const section of document.sections) {
            const lines = section.text.split(/\r?\n/u)
            for (const [index, text] of lines.entries()) {
              scanned += 1
              if (!text.includes(pattern)) continue
              if (items.length >= 60) { truncated = true; break }
              items.push({ path: document.path, anchor: section.anchor, line: index + 1, text })
            }
            if (truncated) break
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `在 ${documents.length} 个文档、${scanned} 行中检索 "${pattern}"，命中 ${items.length} 处`,
          notes: truncated ? ['命中数达到 maxItems=60，结果已截断'] : [],
        }
      },
    },
  ],
})
