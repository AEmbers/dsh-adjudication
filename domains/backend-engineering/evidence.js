/**
 * backend-engineering — P7 evidence tools (contract v2, extension point 3).
 *
 * REUSE PLUS ONE
 * --------------
 * The three bounded tools a diff reviewer needs (`read_lines`, `search_diff`,
 * `enclosing`) are code-review's, reused BY REFERENCE: the toolkit below spreads
 * their `execute` functions into a new toolkit, so the domain gets the same
 * bounded behaviour without a third copy of it. `test.mjs` asserts the function
 * identity (`tools[i].execute === codeReviewTools[i].execute`), because a copy
 * would look identical in review and drift the first time one side was fixed.
 *
 * The one domain tool is `interface_delta`: a backend reviewer's first question
 * about a diff is "did the interface change", and that question can be answered
 * by a bounded scan of the ADDED lines for declaration shapes — without a
 * language server, and without pretending the scan is a type checker.
 */

import { ERROR_CODES, contractError, defineEvidenceTool, defineEvidenceToolkit } from '../../lib/contracts.js'
import codeReviewEvidence from '../code-review/evidence.js'

const DOCUMENTS_SCHEMA = {
  type: 'array',
  description: '可比对文档：[{ path, content }]（diff 或展开后的源文件）。内容必须由调用方注入；工具自身不读文件系统。',
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
    .map((entry) => ({ path: entry.path, content: typeof entry.content === 'string' ? entry.content : '' }))
}

/**
 * Declaration shapes, by language family. Deliberately coarse: this is a
 * LOCATOR for a human's attention, not a parser, and the tool says so in its
 * `provenance`. A miss here costs a second look; a false confident match would
 * cost a wrong review.
 */
const DECLARATION_PATTERNS = [
  ['proto', /^\s*(message|enum|service|rpc|oneof)\s+[A-Za-z_]/u],
  ['proto-field', /^\s*(optional|repeated|required)\s+[\w.<>]+\s+\w+\s*=\s*\d+/u],
  ['go-type', /^\s*type\s+\w+\s+(struct|interface)\b/u],
  ['go-func', /^\s*func\s+(\([^)]*\)\s*)?\w+\s*\(/u],
  ['ts-decl', /^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const)\s+\w+/u],
  ['jvm-fn', /^\s*(public|private|protected|internal|static|final)[\w\s<>\[\],]*\s+\w+\s*\(/u],
  ['sql-ddl', /^\s*(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|COLUMN|TYPE)\b/iu],
  ['py-def', /^\s*(async\s+)?(def|class)\s+\w+/u],
]

export default defineEvidenceToolkit({
  tools: [
    // --- reused by reference from code-review ------------------------------
    ...codeReviewEvidence.tools,
    // --- the domain's own --------------------------------------------------
    defineEvidenceTool({
      name: 'interface_delta',
      description: '在变更里扫出「接口形状」的行：新增行中像声明（proto message/field、Go type/func、TS interface/class/function、JVM 方法、SQL DDL）的语句。粗筛定位用，不是类型检查器。',
      parameters: {
        type: 'object',
        properties: {
          documents: DOCUMENTS_SCHEMA,
          path: { type: 'string', description: '限定在某个文件内（可省略）' },
          side: { type: 'string', enum: ['added', 'all'], description: '只扫新增行（默认 added），或扫全部行' },
        },
        required: ['documents'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 400, maxItems: 80, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const documents = documentsFrom(args)
        const side = args?.side === 'all' ? 'all' : 'added'
        const scoped = args?.path === undefined || args?.path === null
          ? documents
          : documents.filter((document) => document.path === args.path || document.path.endsWith(String(args.path)))
        if (scoped.length === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `文档集里没有 "${String(args?.path)}"。可比对的有：${documents.map((document) => document.path).join(', ') || '(空)'}`)
        }
        const items = []
        let truncated = false
        let scanned = 0
        for (const document of scoped) {
          const lines = String(document.content).split(/\r?\n/u)
          for (let index = 0; index < lines.length; index += 1) {
            const raw = lines[index]
            if (side === 'added' && !raw.startsWith('+')) continue
            scanned += 1
            // The diff marker is syntax, not code: strip it in BOTH modes, or
            // `side: 'all'` would stop matching every added line.
            const text = raw.startsWith('+') ? raw.slice(1) : raw
            const hit = DECLARATION_PATTERNS.find(([, pattern]) => pattern.test(text))
            if (hit === undefined) continue
            if (items.length >= 80) { truncated = true; break }
            items.push({ path: document.path, line: index + 1, kind: hit[0], text })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${scoped.length} 个文件 / 扫过 ${scanned} 行（${side === 'added' ? '仅新增行' : '全部行'}），命中 ${items.length} 处声明形状；粗筛，非语法解析`,
          notes: truncated ? ['命中数达到 maxItems=80，结果已截断'] : [],
        }
      },
    }),
  ],
})
