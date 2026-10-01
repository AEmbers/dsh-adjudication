/**
 * requirement-research — P7 evidence tools (contract v2, extension point 3).
 *
 * TWO QUESTIONS A REQUIREMENTS ANALYST MAY ACTUALLY ASK
 * -----------------------------------------------------
 *   quote_lookup   这段原话在语料里出现过几次、在哪几场？ —— 引用之前先确认它唯一
 *   session_index  语料覆盖了哪些场次/角色，各有多少句？ —— 样本偏差不是感觉，是计数
 *
 * Both read ONLY the corpus the caller injects through `args.documents`. No tool
 * touches the filesystem: this package has zero runtime imports by design, and
 * an evidence tool that read files on its own would break that on the first host
 * that links the plugin instead of installing it.
 *
 * BOUNDING IS STRUCTURAL, NOT DECORATIVE: `limits` is clamped against the
 * contract's hard ceilings by `defineEvidenceToolkit`, every result carries
 * `{ items, truncated, provenance }`, and a cut result says it was cut.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'

const DOCUMENTS_SCHEMA = {
  type: 'array',
  description: '语料文档：[{ path: "sessions/<id>", content: 一句一行的原话, times?: [] }]。由调用方注入，工具自身不读文件系统。',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
}

function documentsFrom(args) {
  const raw = args?.documents
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `documents`：[{ path, content }]。取证工具不接受空上下文，否则它只会不断地报「找不到」。')
  }
  return raw
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
    .map((entry) => ({
      path: entry.path,
      content: typeof entry.content === 'string' ? entry.content : '',
      times: Array.isArray(entry.times) ? entry.times : [],
    }))
}

const splitLines = (content) => String(content).split(/\r?\n/u)

function resolveDocument(documents, path) {
  const wanted = String(path ?? '')
  const exact = documents.find((document) => document.path === wanted)
  if (exact !== undefined) return exact
  const suffix = documents.find((document) => document.path.endsWith(wanted))
  if (suffix !== undefined && wanted !== '') return suffix
  throw contractError(ERROR_CODES.E_INPUT_FORMAT,
    `语料里没有 "${wanted}"。可比对的有：${documents.map((document) => document.path).join(', ') || '(空)'}`)
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'quote_lookup',
      description: '在全语料里逐字查找一段原话（子串，区分大小写），返回所有命中处的场次与句号。用于在引用前确认它唯一 —— 命中多于一处时必须并列写出，不得择一。',
      parameters: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: '要查找的字面原话（不是正则）' },
          sessionId: { type: 'string', description: '限定在某场访谈内（可省略）' },
          documents: DOCUMENTS_SCHEMA,
        },
        required: ['quote', 'documents'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 200, maxItems: 60, maxBytes: 65_536, maxCalls: 10 },
      execute(args) {
        const quote = String(args?.quote ?? '')
        if (quote === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`quote` 不能为空')
        const documents = documentsFrom(args)
        const scoped = args.sessionId === undefined || args.sessionId === null
          ? documents
          : [resolveDocument(documents, args.sessionId)]
        const items = []
        let truncated = false
        let scanned = 0
        for (const document of scoped) {
          const lines = splitLines(document.content)
          for (let index = 0; index < lines.length; index += 1) {
            scanned += 1
            if (!lines[index].includes(quote)) continue
            if (items.length >= 60) { truncated = true; break }
            items.push({ path: document.path, turn: index + 1, t: document.times[index] ?? null, text: lines[index] })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 场 / 扫过 ${scanned} 句，命中 ${items.length} 处`,
          notes: truncated
            ? ['命中数达到 maxItems=60，结果已截断 —— 引用前请缩小范围']
            : (items.length > 1 ? ['命中不唯一：引用这条原话前必须并列写出全部位置'] : []),
        }
      },
    },
    {
      name: 'session_index',
      description: '列出语料里每一场访谈的句数与时间跨度。用于检查样本偏差：覆盖面是计数，不是印象。',
      parameters: {
        type: 'object',
        properties: { documents: DOCUMENTS_SCHEMA },
        required: ['documents'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 120, maxItems: 40, maxBytes: 32_768, maxCalls: 6 },
      execute(args) {
        const documents = documentsFrom(args)
        const items = []
        let truncated = false
        for (const document of documents) {
          if (items.length >= 40) { truncated = true; break }
          const lines = splitLines(document.content).filter((line) => line.trim() !== '')
          const times = document.times.filter((value) => typeof value === 'string' && value !== '')
          items.push({
            path: document.path,
            turns: lines.length,
            from: times[0] ?? null,
            to: times.length > 0 ? times[times.length - 1] : null,
          })
        }
        return {
          items,
          truncated,
          provenance: `${documents.length} 场语料，逐场计数（times 缺失时 from/to 为 null，不是 0）`,
          notes: truncated ? ['场次数达到 maxItems=40，结果已截断'] : [],
        }
      },
    },
  ],
})
