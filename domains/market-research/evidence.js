/**
 * market-research — bounded evidence tools (contract v2, extension point 3).
 *
 * Every tool here is BOUNDED by declaration (`limits`) and by behaviour: it
 * returns at most `maxLines` / `maxItems`, sets `truncated` when it cut, and
 * always reports `provenance` (which documents it actually read). The registry
 * registers them on demand as `adjudicate_market_research_evidence_*`.
 *
 * WHAT THESE TOOLS DO NOT DO
 * --------------------------
 * They never read the filesystem and never fetch a URL. The documents arrive
 * from the caller; a tool that went and fetched a page would make a "bounded"
 * review unbounded, and would turn a citation check into an act of network
 * access with its own legal and reproducibility problems. When the context it
 * needs is missing a tool REFUSES — it does not answer "nothing found", because
 * an empty answer and an unanswerable question are different findings and only
 * one of them is honest.
 *
 * HONESTY: `strength_audit` checks the seed against ITSELF — that a claim is not
 * stronger than the source it names. It cannot check whether the source is true,
 * and `provenance` says so.
 */

import { defineEvidenceToolkit } from '../../lib/contracts.js'

const asArray = (value) => (Array.isArray(value) ? value : null)

const str = (value) => (typeof value === 'string' ? value : '')

/** The registry, from `args.registry` or a `research/<…>.json` document. */
function registryOf(args) {
  if (args?.registry !== undefined && args.registry !== null) {
    const sources = asArray(args.registry.sources)
    if (sources === null) throw new Error('`registry` 必须是 { question, sources, claims? }')
    return { question: args.registry.question ?? null, sources, claims: asArray(args.registry.claims) ?? [] }
  }
  for (const document of asArray(args?.documents) ?? []) {
    if (!/^research\/.+\.json$/u.test(String(document?.path ?? ''))) continue
    try {
      const parsed = JSON.parse(str(document?.content))
      const sources = asArray(parsed?.sources)
      if (sources !== null) return { question: parsed.question ?? null, sources, claims: asArray(parsed.claims) ?? [] }
    } catch {
      throw new Error(`文档 ${document.path} 不是合法 JSON：来源登记表无法解析`)
    }
  }
  throw new Error('缺少 `registry`（或一份 research/<…>.json 来源登记表文档）：没有来源表就无法审计证据强度')
}

/** The source cards, from `args.documents` (registry documents excluded). */
function cardsOf(args) {
  const documents = asArray(args?.documents)
  if (documents === null) throw new Error('缺少 `documents`（来源卡片数组）：没有卡片就无法定位原文')
  return documents.filter((document) => !/^research\/.+\.json$/u.test(String(document?.path ?? '')))
}

const linesOf = (document) => str(document?.content).split(/\r?\n/u)

const STRENGTH_LABELS = { primary: '一手', secondary: '二手', speculation: '推测' }

// CHANGED (t33/t24-F2): the two context keys every tool below actually reads
// were missing from their PUBLISHED `parameters.properties`, so a caller that
// followed the schema could not call them at all — `source_card` threw
// 「缺少 documents」, `strength_audit` threw 「缺少 registry」. The declaration is
// now a superset of the implementation, and the test suite derives that
// property mechanically from this file's `args.<key>` reads.
const DOCUMENTS_SCHEMA = {
  type: 'array',
  description: '调用方交回的来源卡片：[{ path, content }]。必须由调用方注入；本工具绝不联网、绝不读盘。',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
}

const REGISTRY_SCHEMA = {
  type: 'object',
  description: '来源登记表 { question, sources, claims? }。也可以不给 registry，而是把登记表作为一份 research/<…>.json 文档放进 documents —— 两种给法等价，registry 优先。',
  properties: { question: { type: 'string' }, sources: { type: 'array' }, claims: { type: 'array' } },
  required: ['sources'],
}

const normalizeStrength = (value) => {
  const key = str(value).trim().toLowerCase()
  if (key === 'primary') return 'primary'
  if (key === 'secondary') return 'secondary'
  return 'speculation'
}
const rank = (value) => ({ speculation: 0, secondary: 1, primary: 2 })[normalizeStrength(value)]

export const tools = [
  {
    name: 'source_card',
    description: '读取一份来源卡片的指定行范围（含证据强度行与逐字引文行）。只读调用方注入的文档，绝不联网、绝不读盘。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '来源卡片的路径，如 research/esg-eu/sources/vendor-report.md' },
        start: { type: 'number', description: '起始行（1-based，默认 1）' },
        documents: DOCUMENTS_SCHEMA,
      },
      required: ['path', 'documents'],
    },
    output: { schema: { type: 'object' } },
    // CHANGED (t33/t24-F3): `maxItems` said 1 while the tool returns one item per
    // line read, i.e. up to `maxLines`. The declaration is the bound a caller can
    // rely on, so it has to describe what the tool can actually return.
    limits: { maxLines: 40, maxItems: 40, maxBytes: 8192, maxCalls: 6 },
    execute(args = {}) {
      const path = str(args.path)
      if (path === '') throw new Error('`path` 必填')
      const cards = cardsOf(args)
      const document = cards.find((entry) => String(entry?.path ?? '') === path)
      if (document === undefined) {
        throw new Error(`来源卡片的文档集里没有 "${path}"（已注入 ${cards.length} 份卡片）：不猜路径、不联网取回`)
      }
      const lines = linesOf(document)
      const start = Number.isInteger(args.start) && args.start > 0 ? args.start : 1
      const slice = lines.slice(start - 1, start - 1 + this.limits.maxLines)
      const strength = /^strength = (\w+)/mu.exec(str(document.content))?.[1] ?? 'unknown'
      return {
        items: slice.map((line, index) => ({ line: start + index, text: line })),
        truncated: start - 1 + slice.length < lines.length,
        provenance: `${path}（第 ${start}-${start + slice.length - 1} 行，共 ${lines.length} 行；卡片声明强度 ${strength}）`,
        notes: [`证据强度：${STRENGTH_LABELS[normalizeStrength(strength)] ?? '未知'}`],
      }
    },
  },
  {
    name: 'quote_lookup',
    description: '在已注入的来源卡片里查找一段文本（整行归一化比对）。用于判断一句引文究竟出自哪份卡片、是否只出自一份。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要查找的文本（归一化后整行比对，转述不会命中）' },
        documents: DOCUMENTS_SCHEMA,
      },
      required: ['text', 'documents'],
    },
    output: { schema: { type: 'object' } },
    limits: { maxLines: 200, maxItems: 20, maxBytes: 16384, maxCalls: 6 },
    execute(args = {}) {
      const wanted = str(args.text).replace(/\s+/gu, ' ').trim()
      if (wanted === '') throw new Error('`text` 必填')
      const cards = cardsOf(args)
      const items = []
      let truncated = false
      for (const document of cards) {
        for (const [index, line] of linesOf(document).entries()) {
          if (line.replace(/\s+/gu, ' ').trim() !== wanted) continue
          if (items.length >= this.limits.maxItems) { truncated = true; break }
          items.push({ path: String(document?.path ?? ''), line: index + 1, text: line })
        }
        if (truncated) break
      }
      return {
        items,
        truncated,
        provenance: `在 ${cards.length} 份来源卡片里按归一化整行查找；命中 ${items.length} 处`,
        notes: [
          items.length === 0
            ? '没有命中：转述、改写标点或改动数字都不会命中，不要把它当成「大概在另一份里」'
            : `命中 ${items.length} 份/处；命中超过一处时，锚点复核会判为歧义而不是挑一份`,
        ],
      }
    },
  },
  {
    name: 'strength_audit',
    description: '逐条列出结论与它的来源强度，标出声明的强度高于来源的结论（二手来源 + 一手结论）。只审计 seed 自身的内部一致性。',
    parameters: {
      type: 'object',
      properties: {
        registry: REGISTRY_SCHEMA,
        documents: DOCUMENTS_SCHEMA,
      },
      // 两条给法等价（registry 优先），所以这里不写 required：写出 required 会把
      // 另一种真实可用的给法排除在「已发布接口」之外。缺两者时工具仍然拒绝回答。
      required: [],
    },
    output: { schema: { type: 'object' } },
    limits: { maxLines: 200, maxItems: 50, maxBytes: 32768, maxCalls: 4 },
    execute(args = {}) {
      const registry = registryOf(args)
      const byId = new Map(registry.sources.map((source) => [String(source?.id ?? ''), source]))
      const items = []
      let truncated = false
      for (const claim of registry.claims) {
        if (items.length >= this.limits.maxItems) { truncated = true; break }
        const sourceId = String(claim?.sourceId ?? '')
        const source = byId.get(sourceId) ?? null
        const sourceStrength = source === null ? null : normalizeStrength(source.strength)
        const claimStrength = normalizeStrength(claim?.strength ?? source?.strength)
        items.push({
          claimId: String(claim?.id ?? ''),
          sourceId,
          sourceStrength,
          claimStrength,
          overclaims: source !== null && rank(claimStrength) > rank(sourceStrength),
          unknownSource: source === null,
        })
      }
      const laundering = items.filter((item) => item.overclaims).map((item) => item.claimId)
      return {
        items,
        truncated,
        provenance: `审计 ${registry.claims.length} 条结论 / ${registry.sources.length} 个来源；只检查「结论不弱于来源」，不检查来源本身为真`,
        notes: laundering.length === 0
          ? ['没有发现强度洗白：每条结论声明的强度不高于它的来源']
          : [`发现 ${laundering.length} 条强度洗白：${laundering.join(', ')} —— 二手来源引用成一手的结论，数字会留下、限定语会丢`],
      }
    },
  },
]

export default defineEvidenceToolkit({ tools })
