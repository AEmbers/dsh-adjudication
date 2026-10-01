/**
 * frontend-engineering — P7 evidence tools (contract v2, extension point 3).
 *
 * REUSE PLUS ONE, same shape as backend-engineering: code-review's three bounded
 * tools are reused BY REFERENCE (same `execute` functions), and the domain adds
 * the one tool a client-side reviewer keeps reaching for — `render_scope`, which
 * answers "which component/scope is this line inside?", because that is the
 * question behind most render-time side effects, hook-order and stale-closure
 * findings.
 *
 * The walk is INDENTATION-AND-PATTERN based and says so in its provenance: it is
 * a locator, not a parser. A miss costs a second look; a confidently wrong scope
 * would cost a wrong review.
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

function resolveDocument(documents, path) {
  const wanted = String(path ?? '')
  const exact = documents.find((document) => document.path === wanted)
  if (exact !== undefined) return exact
  const suffix = documents.find((document) => document.path.endsWith(wanted))
  if (suffix !== undefined && wanted !== '') return suffix
  throw contractError(ERROR_CODES.E_INPUT_FORMAT,
    `文档集里没有 "${wanted}"。可比对的有：${documents.map((document) => document.path).join(', ') || '(空)'}`)
}

/** Declaration shapes that open a component/scope in the frameworks in play. */
const SCOPE_PATTERNS = [
  ['react-component', /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Z]\w*/u],
  ['react-arrow', /^\s*(export\s+)?const\s+[A-Z]\w*\s*(:[^=]+)?=\s*(\(|async\s*\()/u],
  ['class-component', /^\s*(export\s+)?(default\s+)?class\s+\w+\s+extends\s+(React\.)?(Pure)?Component\b/u],
  ['vue-script-setup', /^\s*<script\s+setup/u],
  ['vue-define', /^\s*(export\s+default\s+)?defineComponent\s*\(/u],
  ['svelte-script', /^\s*<script\b/u],
  ['hook', /^\s*(export\s+)?(async\s+)?function\s+use[A-Z]\w*/u],
]

export default defineEvidenceToolkit({
  tools: [
    // --- reused by reference from code-review ------------------------------
    ...codeReviewEvidence.tools,
    // --- the domain's own --------------------------------------------------
    defineEvidenceTool({
      name: 'render_scope',
      description: '从目标行向上找出它所在的组件/作用域起点（函数组件、箭头组件、class 组件、<script setup>、hook）。缩进与模式粗筛，不是语法解析。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          line: { type: 'integer', description: '目标行（1-based）' },
          documents: DOCUMENTS_SCHEMA,
        },
        required: ['path', 'line', 'documents'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 60, maxItems: 20, maxBytes: 32_768, maxCalls: 8 },
      execute(args) {
        const documents = documentsFrom(args)
        const document = resolveDocument(documents, args.path)
        const lines = String(document.content).split(/\r?\n/u)
        const target = Number.isInteger(args.line) && args.line >= 1 ? args.line : 1
        if (target > lines.length) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `第 ${target} 行超出 ${document.path}（共 ${lines.length} 行）`)
        }

        // Walk UP, bounded, to the nearest scope opener. A component that opens
        // more than 60 lines above the target is not reported, and that is said
        // in `truncated` rather than papered over with a guessed scope.
        const MAX_STEPS = 60
        let start = null
        let kind = 'module'
        let steps = 0
        for (let number = target - 1; number >= 1 && steps < MAX_STEPS; number -= 1) {
          steps += 1
          const hit = SCOPE_PATTERNS.find(([, pattern]) => pattern.test(lines[number - 1]))
          if (hit !== undefined) { start = number; kind = hit[0]; break }
        }
        const bounded = start !== null
        const from = bounded ? start : target
        const items = []
        for (let number = from; number <= target && items.length < 20; number += 1) {
          items.push({ path: document.path, line: number, text: lines[number - 1] ?? '' })
        }
        return {
          items,
          truncated: !bounded || (target - from + 1 > items.length),
          provenance: bounded
            ? `${document.path}:${from}-${target}（作用域 ${kind}，向上回溯 ${steps} 行；粗筛，非语法解析）`
            : `${document.path}:${target}（向上 ${steps} 行内没有找到作用域起点 —— 报未知，不猜）`,
          notes: bounded ? [] : ['未找到作用域起点：可能是模块顶层，或组件开头在 60 行以外。不要据此推断 hook 顺序。'],
        }
      },
    }),
  ],
})
