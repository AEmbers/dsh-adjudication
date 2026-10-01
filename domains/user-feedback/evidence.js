/**
 * user-feedback — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT THESE ARE FOR
 * ------------------
 * A bounded reviewer needs to ask questions OF THE LEDGER, and the only thing it may
 * not have is unlimited access. Each tool declares `limits`; the toolkit is clamped
 * to the contract's ceilings by `normaliseEvidenceLimits`, and every result carries
 * `{ items, truncated, provenance }` — a result cut short says so.
 *
 * Six questions, chosen because they are the ones a feedback reviewer cannot answer
 * from the record in front of it:
 *
 *   feedback_record    what does this item actually say, and is it closed?  (bounded body)
 *   closure_status     which sides of this item's closure exist?           (the domain's crux)
 *   decision_links     what does this decision claim, and what does it get? (both directions)
 *   unclosed_feedback  every item with an incomplete closure               (the recall-first work list)
 *   ledger_ranks       loss and frequency ranked SEPARATELY, plus drownRisk
 *   quote_search       where does this phrase verbatim occur?              (bounded search)
 *
 * THE ONE THAT IS NOT LIKE THE OTHERS
 * -----------------------------------
 * `ledger_ranks` is the reason this file exists rather than a generic "read the
 * ledger" tool. Its output keeps `byLoss` and `byFrequency` as two lists and adds
 * `drownRisk`: items in the top loss quartile sitting in the bottom half by
 * frequency. A single merged score would have been shorter, more familiar and less
 * useful — and it is precisely the shape that lets a once-reported data-loss bug be
 * buried by a forty-times-reported cosmetic complaint. The separation is a contract
 * of this domain (asserted in `test.mjs` against a fixture built to make the two
 * orderings disagree), not a formatting preference.
 *
 * WHY THESE READ `args.corpus` AND NOT FILES
 * -------------------------------------------
 * The caller injects the ledger documents. This package has zero runtime imports and
 * an evidence tool that reached for `node:fs` would break that on the first host that
 * links the plugin instead of installing it. It also means the tools answer about the
 * SAME corpus the anchor verifier sees: a tool that re-read the filesystem could
 * confirm a closure in a ledger the verifier never saw.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'
import { slash } from '../_lib/graph.js'
import {
  closureGaps,
  ledgerRanks,
  normalizeQuote,
  populations,
  quoteMatches,
  themeOf,
} from './source.js'

const CORPUS_SCHEMA = {
  type: 'array',
  description: '反馈台账语料：[{ path, type?, payload: { feedback, decisions, themes }, meta? }]。必须由调用方注入；工具自身不读文件系统。',
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

/** Normalise `args.corpus`, accepting a bare payload as a convenience. */
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
    if (Array.isArray(entry.feedback) || Array.isArray(entry.decisions)) {
      documents.push({ path: slash(entry.path ?? `corpus/${index}/ledger.json`), payload: entry })
      continue
    }
    if (entry.payload !== null && typeof entry.payload === 'object') {
      documents.push({ path: slash(entry.path ?? `corpus/${index}/ledger.json`), payload: entry.payload })
    }
  }
  if (documents.length === 0) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'corpus 里没有可读的反馈台账（需要 path + payload.feedback/decisions）')
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
    `语料里没有台账 "${wanted}"。可比对的有：${documents.map((document) => document.path).join(', ')}`)
}

/** `--path`/absent -> the scoped document list. */
function scope(documents, path) {
  return path === undefined || path === null ? documents : [resolveDocument(documents, path)]
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'feedback_record',
      description: '读一条反馈的登记内容（逐字原话、来源、严重度、频次、主题、闭环状态）。正文有行数上限。',
      parameters: {
        type: 'object',
        properties: {
          feedbackId: { type: 'string', description: '反馈 ID' },
          path: { type: 'string', description: '台账文档路径（可省略：会在全部语料里查找该 ID）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['feedbackId', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 60, maxItems: 4, maxBytes: 32_768, maxCalls: 10 },
      execute(args) {
        const feedbackId = String(args?.feedbackId ?? '')
        if (feedbackId === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`feedbackId` 不能为空')
        const documents = corpusFrom(args)
        const items = []
        let truncated = false
        for (const document of scope(documents, args.path)) {
          const { feedbackById, decisions } = populations({ payload: document.payload })
          const item = feedbackById.get(feedbackId)
          if (item === undefined) continue
          if (items.length >= 4) { truncated = true; break }
          const body = typeof item.body === 'string' ? item.body : ''
          const lines = body.split(/\r?\n/u)
          const clipped = lines.length > 60
          if (clipped) truncated = true
          items.push({
            path: document.path,
            feedbackId,
            quote: normalizeQuote(item.quote),
            source: item.source ?? null,
            severity: item.severity ?? null,
            reach: item.reach ?? null,
            frequency: Number.isFinite(Number(item.frequency)) ? Number(item.frequency) : null,
            theme: themeOf(item),
            status: item.status ?? null,
            closedBy: item.closedBy ?? null,
            closeReason: item.closeReason ?? null,
            closedByExists: item.closedBy === undefined ? null : decisions.some((d) => d?.id === item.closedBy),
            body: clipped ? lines.slice(0, 60).join('\n') : body,
          })
        }
        if (items.length === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `语料里没有反馈记录 "${feedbackId}"。若这个 ID 只出现在某个决策的 addresses 里，那它就是**未登记的引用** —— 那是一条发现，不是一个可以补全的查询。`)
        }
        return {
          items,
          truncated,
          provenance: `${documents.length} 份台账，命中 ${items.length} 条反馈记录；正文上限 60 行`,
          notes: truncated ? ['正文或记录数达到上限，结果已截断'] : [],
        }
      },
    },
    {
      name: 'closure_status',
      description: '一条反馈的闭环两侧各是什么状态：决策的 addresses 是否提到它、它自己的 closedBy 是否指向那个决策。单边声明会明确标出。',
      parameters: {
        type: 'object',
        properties: {
          feedbackId: { type: 'string', description: '反馈 ID' },
          path: { type: 'string', description: '台账文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['feedbackId', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 80, maxItems: 20, maxBytes: 32_768, maxCalls: 12 },
      execute(args) {
        const feedbackId = String(args?.feedbackId ?? '')
        if (feedbackId === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`feedbackId` 不能为空')
        const documents = corpusFrom(args)
        const items = []
        let truncated = false
        for (const document of scope(documents, args.path)) {
          const { feedbackById, decisions } = populations({ payload: document.payload })
          if (!feedbackById.has(feedbackId)) continue
          const { gaps } = closureGaps(document)
          const gap = gaps.find((entry) => entry.feedbackId === feedbackId) ?? null
          if (items.length >= 20) { truncated = true; break }
          const addressedBy = [...new Set(decisions
            .filter((decision) => (Array.isArray(decision?.addresses) ? decision.addresses : []).includes(feedbackId))
            .map((decision) => String(decision.id)))]
          items.push({
            path: document.path,
            feedbackId,
            closedBy: feedbackById.get(feedbackId).closedBy ?? null,
            addressedBy,
            mutual: addressedBy.filter((id) => feedbackById.get(feedbackId).closedBy === id),
            gap: gap === null ? null : { kind: gap.kind, side: gap.side, reason: gap.reason },
            closed: gap === null,
          })
        }
        if (items.length === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `语料里没有反馈记录 "${feedbackId}"，无法回答它的闭环状态`)
        }
        return {
          items,
          truncated,
          provenance: `${documents.length} 份台账，命中 ${items.length} 条；闭环判据＝决策 addresses 与反馈 closedBy 双侧一致`,
          notes: items.some((item) => !item.closed)
            ? ['有未闭合项：单边声明不算闭环，请把每一条写进报告']
            : [],
        }
      },
    },
    {
      name: 'decision_links',
      description: '一个决策声明处理了哪些反馈，以及其中有多少条是真的双侧互证。也给出它有没有被任何 closedBy 指向。',
      parameters: {
        type: 'object',
        properties: {
          decisionId: { type: 'string', description: '决策 ID' },
          path: { type: 'string', description: '台账文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['decisionId', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 80, maxItems: 12, maxBytes: 32_768, maxCalls: 10 },
      execute(args) {
        const decisionId = String(args?.decisionId ?? '')
        if (decisionId === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`decisionId` 不能为空')
        const documents = corpusFrom(args)
        const items = []
        let truncated = false
        for (const document of scope(documents, args.path)) {
          const { decisionById } = populations({ payload: document.payload })
          const decision = decisionById.get(decisionId)
          if (decision === undefined) continue
          if (items.length >= 12) { truncated = true; break }
          const declared = (Array.isArray(decision.addresses) ? decision.addresses : []).map(String)
          const { gaps } = closureGaps(document)
          const mutual = declared.filter((id) => !gaps.some((gap) => gap.feedbackId === id))
          items.push({
            path: document.path,
            decisionId,
            title: decision.title ?? null,
            status: decision.status ?? null,
            owner: decision.owner ?? null,
            declaredAddresses: declared,
            mutualClosures: mutual,
            oneSided: declared.filter((id) => !mutual.includes(id)),
            orphan: declared.length === 0,
          })
        }
        if (items.length === 0) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `语料里没有决策记录 "${decisionId}"。若它只出现在某条反馈的 closedBy 里，那它是一条**悬空的闭环声明** —— 那是一条发现。`)
        }
        return {
          items,
          truncated,
          provenance: `${documents.length} 份台账，命中 ${items.length} 条决策记录`,
        }
      },
    },
    {
      name: 'unclosed_feedback',
      description: '列出所有闭环不完整的反馈（无闭环、或只有单边声明）、所有失效引用（addresses/closedBy 指向不存在的 ID），以及所有与台账无关的决策。这是 recall-first 的工作清单，逐条列出而不是给一个计数；每项都带 kind，读者必须能分清「没人处理」与「处理记录指向不存在的东西」。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '台账文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 200, maxItems: 100, maxBytes: 65_536, maxCalls: 8 },
      execute(args) {
        const documents = corpusFrom(args)
        const items = []
        let truncated = false
        for (const document of scope(documents, args.path)) {
          const { gaps, orphanDecisions } = closureGaps(document)
          for (const gap of gaps) {
            if (items.length >= 100) { truncated = true; break }
            items.push({ path: document.path, ...gap })
          }
          if (truncated) break
          for (const orphan of orphanDecisions) {
            if (items.length >= 100) { truncated = true; break }
            items.push({ path: document.path, kind: 'orphan-decision', feedbackId: null, decisionId: orphan.decisionId, side: 'none', reason: orphan.reason })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${documents.length} 份台账，逐条列出 ${items.length} 项闭环缺口`,
          notes: items.length === 0
            ? ['这份台账的闭环没有缺口 —— 空清单是合法结论，不要为了填满它而把好闭环写进去']
            : [`${items.length} 项缺口已逐条列出：报告里必须一条不漏，只报计数等于把清单藏起来`],
        }
      },
    },
    {
      name: 'ledger_ranks',
      description: '把「严重度 × 影响面」与「被报次数」分成两个独立排序，并单独列出 drownRisk —— 高损失但低频、会被频次排序淹没的条目。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '台账文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 200, maxItems: 120, maxBytes: 65_536, maxCalls: 6 },
      execute(args) {
        const documents = corpusFrom(args)
        const items = []
        const notes = []
        const maxItems = 120
        for (const document of scope(documents, args.path)) {
          const ranks = ledgerRanks(document)
          for (const row of ranks.rows) {
            if (items.length >= maxItems) { notes.push('条目数达到 maxItems=120，结果已截断'); break }
            items.push({
              path: document.path,
              ...row,
              lossRank: ranks.byLoss.indexOf(row.id) + 1,
              frequencyRank: ranks.byFrequency.indexOf(row.id) + 1,
              drownRisk: ranks.drownRisk.includes(row.id),
            })
          }
        }
        const drowned = items.filter((item) => item.drownRisk).map((item) => item.id)
        if (drowned.length > 0) {
          notes.push(`drownRisk 非空：${drowned.join('、')} 的损失排在前四分之一、频次排在倒数一半 —— 按次数排序会把它们淹没，必须在报告里单独点名`)
        }
        return {
          items,
          truncated: notes.some((note) => note.includes('截断')),
          provenance: `${documents.length} 份台账，${items.length} 条反馈；loss = 严重度权重 × 影响面权重，frequency 独立计数`,
          notes,
        }
      },
    },
    {
      name: 'quote_search',
      description: '在反馈原话里逐字搜索一段文字，返回命中的反馈 ID（有界）。用于确认一条引文到底出自哪条记录。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要逐字搜索的片段（至少 8 个字符）' },
          path: { type: 'string', description: '台账文档路径（可省略）' },
          corpus: CORPUS_SCHEMA,
        },
        required: ['text', 'corpus'],
      },
      output: { schema: { type: 'object', properties: { items: { type: 'array' }, truncated: { type: 'boolean' }, provenance: { type: 'string' } } } },
      limits: { maxLines: 120, maxItems: 50, maxBytes: 32_768, maxCalls: 12 },
      execute(args) {
        const text = String(args?.text ?? '')
        if (text === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`text` 不能为空')
        const documents = corpusFrom(args)
        const items = []
        let truncated = false
        const wanted = normalizeQuote(text)
        for (const document of scope(documents, args.path)) {
          const hits = quoteMatches({ payload: document.payload }, wanted)
          for (const feedbackId of hits) {
            if (items.length >= 50) { truncated = true; break }
            const { feedbackById } = populations({ payload: document.payload })
            items.push({ path: document.path, feedbackId, quote: normalizeQuote(feedbackById.get(feedbackId)?.quote) })
          }
          if (truncated) break
        }
        return {
          items,
          truncated,
          provenance: `${documents.length} 份台账，${items.length} 条原话逐字包含该片段（匹配前空白已折叠，大小写不折叠）`,
          notes: items.length === 0
            ? ['没有任何原话逐字包含这段文字 —— 若是转述，它不构成锚点']
            : (items.length > 1 ? ['命中多条记录：这段引文本身不能唯一确定一条反馈，需要一并给出 feedbackId'] : []),
        }
      },
    },
  ],
})
