/**
 * product-planning — P5 anchor verifier (contract v2, extension point 2).
 *
 * WHAT AN ANCHOR IS HERE: `requirement-and-metric`
 * ------------------------------------------------
 * A plan item hangs on TWO checkable facts, and the engine re-derives both:
 *   1. the requirement it claims to serve — its title, quoted word for word;
 *   2. the metric it claims to move — the name must be DECLARED by the material
 *      handed over (`documents[].metrics`), not merely asserted in prose.
 *
 * That pairing is the domain's mechanical answer to "可度量": 没有基线的「提升
 * X%」不成立，而没有声明过的指标名连锚点都不是。A claim whose metric cannot be
 * found is UNANCHORED — a missing baseline is a real failure of the plan, and
 * this verifier refuses to let it through as a stylistic remark.
 *
 * DOCUMENT SHAPE
 * --------------
 *   { path: 'requirements/r1', content: '标题\n正文…', metrics: [] }
 *   { path: 'plans/p1',       content: '方案标题…',   metrics: ['对账时长'] }
 * `metrics` is the declared metric vocabulary of that document. When a claim
 * names a plan (`locator.planId`) the metric must be declared by THAT plan —
 * a metric that exists somewhere else is not this plan's metric.
 *
 * Refusals, unchanged from the contract's ladder: paraphrase -> no-match,
 * contradicting locator -> locator-mismatch, two equally good locations ->
 * relocation-ambiguous, missing metric -> no-match (with the reason spelled out).
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

const KIND = 'requirement-and-metric'

/** Collapse ALL whitespace; change nothing else. A paraphrase is not a quote. */
const normalizeLine = (line) => String(line).replace(/\s+/gu, '')

function normalizeExcerpt(excerpt) {
  return String(excerpt).split(/\r?\n/u).map(normalizeLine).filter((line) => line.length > 0)
}

export function allMatches(content, needle) {
  if (needle.length === 0) return []
  const lines = String(content).split(/\r?\n/u).map(normalizeLine)
  const hits = []
  for (let start = 0; start + needle.length <= lines.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[start + offset] !== needle[offset]) { matched = false; break }
    }
    if (matched) hits.push({ start: start + 1, end: start + needle.length })
  }
  return hits
}

export function matchesAt(content, needle, startLine) {
  const lines = String(content).split(/\r?\n/u)
  if (!Number.isInteger(startLine) || startLine < 1 || startLine + needle.length - 1 > lines.length) return false
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (normalizeLine(lines[startLine - 1 + offset]) !== needle[offset]) return false
  }
  return true
}

const unanchored = (tier, detail, extra = {}) => ({ status: 'unanchored', tier, path: null, start: null, end: null, detail, ...extra })
const anchored = (path, start, end, tier, detail) => ({ status: 'anchored', tier, path, start, end, ...(detail === undefined ? {} : { detail }) })

function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string' ? entry.content : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    const metrics = Array.isArray(entry.metrics) ? entry.metrics.map((value) => String(value)) : []
    documents.push({ path, content, metrics })
  }
  return documents
}

/** Where the declared metric lives. `planId` narrows it to one plan. */
function metricHolders(documents, metricName, planId) {
  const wanted = String(metricName)
  return documents.filter((document) => {
    if (planId !== undefined && planId !== null && document.path !== planId) return false
    return document.metrics.includes(wanted)
  })
}

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:object[]}} subject
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt? }')
  }
  if (typeof claim.kind !== 'string' || claim.kind === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (typeof claim.path !== 'string' || claim.path === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`（应为 `requirements/<id>`）')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可省略）')
  }

  if (claim.kind !== KIND) {
    return unanchored('kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }

  const locator = claim.locator ?? {}
  const declaredLine = locator.startLine
  if (declaredLine !== undefined && declaredLine !== null && (!Number.isInteger(declaredLine) || declaredLine < 1)) {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, 'locator.startLine 必须是 >= 1 的整数')
  }

  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', '抄写的需求原文规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null
  const subjectMetrics = Array.isArray(subject?.metrics) ? subject.metrics.map(String) : []
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent, metrics: subjectMetrics }
    : documents.find((document) => document.path === preferred) ?? null
  const others = documents.filter((document) => document.path !== preferred)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', '没有提供任何可比对的需求/方案材料 —— 无法重算锚点')
  }

  // The metric half is checked FIRST when it is declared: a plan item whose
  // metric nobody declared is not a plan item, whatever its quotation looks like.
  const metricName = locator.metricName
  if (metricName !== undefined && metricName !== null && String(metricName) !== '') {
    const scope = named === null ? documents : [named, ...others]
    const holders = metricHolders(scope, metricName)
    if (holders.length === 0) {
      const where = locator.planId === undefined ? '任何可比对材料' : `方案 "${locator.planId}"`
      return unanchored('no-match',
        `指标 "${metricName}" 在${where}里没有声明 —— 没有声明过的指标不能作为方案的目标，锚点不成立`)
    }
    if (locator.planId !== undefined && !holders.some((document) => document.path === locator.planId)) {
      return unanchored('no-match', `指标 "${metricName}" 存在，但不是方案 "${locator.planId}" 声明的 —— 借来的指标不算这个方案的目标`)
    }
  }

  if (named !== null) {
    if (Number.isInteger(declaredLine) && declaredLine >= 1) {
      if (matchesAt(named.content, needle, declaredLine)) {
        return anchored(named.path, declaredLine, declaredLine + needle.length - 1, 'declared-locator',
          `第 ${declaredLine} 行需求原文确认无误`)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declaredLine} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测`)
    }
    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique', `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行）`)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写的需求原文在 ${named.path} 中逐字未命中 —— 转述的需求不等于需求原文`)
    }
    return unanchored('relocation-ambiguous', `需求原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }

  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    return anchored(hits[0].path, hits[0].start, hits[0].end, 'relocated-unique',
      `声明的 "${preferred}" 不在材料里；需求原文在 "${hits[0].path}" 唯一命中，锚点已搬迁`)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous',
      `声明的 "${preferred}" 不在材料里，且需求原文在 ${hits.length} 处命中 —— 搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  return unanchored('no-match', `声明的 "${preferred}" 与任何可比对材料都不含这段需求原文`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '需求原文滑窗 + 指标声明核验：需求必须逐字命中，指标必须由对应方案声明；两者缺一即未锚定。',
  verify,
})
