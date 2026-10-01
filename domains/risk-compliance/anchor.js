/**
 * risk-compliance — P5 anchor verifier (contract v2, extension point 2).
 *
 * THE DUAL ANCHOR, AND WHY BOTH HALVES ARE MANDATORY
 * --------------------------------------------------
 * A compliance finding has two independent halves, and this file refuses to
 * accept either one alone:
 *
 *   RULE side      `locator.clauseId` must name a clause that really exists in
 *                  the clause register the verifier was handed. The engine
 *                  recomputes it; the model's say-so is not evidence.
 *   EVIDENCE side  the verbatim excerpt must re-locate in the subject material
 *                  through the same ladder the rest of the package uses.
 *
 *   clause only    -> unanchored. An accusation with no quotable evidence is
 *                     not a finding, it is an opinion.
 *   evidence only  -> unanchored. Text with no clause behind it is not a
 *                     COMPLIANCE finding; it has no rule side to violate.
 *
 * Additionally, when the enumerated candidate set is supplied, the (clause,
 * surface) PAIR must exist in it. A claim that binds a clause to a surface the
 * candidate set never produced is exactly the "I am sure, so I will invent the
 * binding" failure this domain exists to refuse.
 *
 * TIER MAPPING (the tier vocabulary is closed — `ANCHOR_TIERS` in
 * `lib/contracts.js` — so domain-specific failures map onto it explicitly)
 * ---------------------------------------------------------------------
 *   clause id missing / unknown ......... `no-match`
 *   (clause, surface) pair absent ....... `no-match`
 *   excerpt empty ....................... `empty-excerpt`
 *   no register and no documents ........ `no-documents`
 *   every evidence-ladder failure ....... `locator-mismatch` /
 *                                         `relocation-ambiguous` /
 *                                         `no-match` / `kind-mismatch`
 * The mapping is documented here because a reader must be able to tell WHY a
 * claim was refused without reading the code.
 *
 * MATCHING IS LITERAL. Only whitespace is dropped (`normalizeLine`). A
 * paraphrase, a renamed identifier or a changed punctuation mark is a DIFFERENT
 * line, and this verifier says so instead of scoring a near miss.
 *
 * PORTING: `normalizeLine` and the sliding-window match are the same idiom
 * NOTICE already lists for lib/engine.js and domains/code-review/anchor.js
 * (ported from open-code-review, `internal/diff/resolver.go`). The same
 * deviation applies: the ladder ends at "unanchored" — there is no LLM
 * re-location tier, because an anchor a model guessed is not an anchor an
 * engine can verify. Everything above the ladder (the clause/surface binding
 * recomputation) is original to this domain and has no upstream counterpart.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

/** Strip surrounding whitespace — the comparison form of one line. */
function normalizeLine(line) {
  return String(line).replace(/\s+/gu, '')
}

/** Normalise an excerpt into its comparison lines. Blank lines are dropped. */
function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

/** The anchor kind this domain verifies. Declared before use, deliberately. */
const KIND = 'clause-and-evidence'

const lineCount = (content) => String(content).split(/\r?\n/u).length

/** All places `needle` appears in `content`, as 1-based inclusive spans. */
function allMatches(content, needle) {
  if (needle.length === 0) return []
  const lines = String(content).split(/\r?\n/u)
  const normalised = lines.map(normalizeLine)
  const hits = []
  for (let start = 0; start + needle.length <= normalised.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (normalised[start + offset] !== needle[offset]) { matched = false; break }
    }
    if (matched) hits.push({ start: start + 1, end: start + needle.length })
  }
  return hits
}

/** Does the excerpt sit EXACTLY at `startLine` in this document? */
function matchesAt(content, needle, startLine) {
  const lines = String(content).split(/\r?\n/u)
  if (startLine < 1 || startLine + needle.length - 1 > lines.length) return false
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (normalizeLine(lines[startLine - 1 + offset]) !== needle[offset]) return false
  }
  return true
}

const unanchored = (tier, detail, extra = {}) => ({
  status: 'unanchored',
  tier,
  path: null,
  start: null,
  end: null,
  clause: null,
  detail,
  ...extra,
})

const anchored = (path, start, end, tier, detail, clause) => ({
  status: 'anchored',
  tier,
  path,
  start,
  end,
  clause,
  detail,
})

/**
 * Normalise `subject.documents` into `[{ path, content }]`, tolerating the
 * `{ path, text }` spelling a caller may reach for.
 */
function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string'
      ? entry.content
      : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    documents.push({ path, content })
  }
  return documents
}

/** The clause register: `subject.clauses`, or the clause ids carried by the candidates. */
function toClauses(subject) {
  if (Array.isArray(subject?.clauses)) {
    return subject.clauses
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => ({ id: entry.id, title: entry.title ?? null, text: entry.text ?? null }))
  }
  return null
}

/** The enumerated bindings, when the caller supplies them. */
function toBindings(subject) {
  const raw = Array.isArray(subject?.candidates) ? subject.candidates : null
  if (raw === null) return null
  const bindings = new Set()
  for (const candidate of raw) {
    if (candidate === null || typeof candidate !== 'object') continue
    const clauseId = candidate?.meta?.clauseId ?? candidate?.locator?.clauseId
    const surfaceId = candidate?.meta?.surfaceId ?? candidate?.locator?.surfaceId
    if (typeof clauseId === 'string' && typeof surfaceId === 'string') bindings.add(`${clauseId}\u0000${surfaceId}`)
  }
  return bindings
}

/**
 * Verify one dual-anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:{clauseId?:string,surfaceId?:string,startLine?:number},excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:Array<{path:string,content:string}>,clauses?:Array<object>,candidates?:Array<object>}} subject
 * @returns {object} an AnchorVerdict — see the tier mapping at the top of the file
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt? }')
  }
  if (typeof claim.kind !== 'string' || claim.kind === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (typeof claim.path !== 'string' || claim.path === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可省略）')
  }

  if (claim.kind !== KIND) {
    return unanchored('kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }

  const locator = claim.locator ?? {}
  const clauseId = typeof locator.clauseId === 'string' && locator.clauseId.trim() !== '' ? locator.clauseId.trim() : null
  const surfaceId = typeof locator.surfaceId === 'string' && locator.surfaceId.trim() !== '' ? locator.surfaceId.trim() : null

  // --- EVIDENCE half: is there anything quotable at all? --------------------
  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt',
      '证据侧锚点为空：抄写的原文规范化后为空 —— 双锚点缺「证据原文」一半，不得据以出结论')
  }

  // --- RULE half: does the claimed clause exist? ----------------------------
  const clauses = toClauses(subject)
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null
  if (clauses === null && documents.length === 0 && subjectContent === null) {
    return unanchored('no-documents', '既没有条款清单、也没有可比对的文档内容 —— 双锚点两侧都无法重算')
  }

  if (clauseId === null) {
    return unanchored('no-match',
      '规则侧锚点缺失：没有 locator.clauseId。双锚点缺「条款 ID」一半即判未锚定 —— 无法给出条款依据时，应标记为「待定条款」并保留，而不是当作已锚定的合规发现')
  }
  if (clauses !== null && !clauses.some((entry) => entry.id === clauseId)) {
    return unanchored('no-match',
      `条款 ID "${clauseId}" 不在条款清单里（清单共 ${clauses.length} 条）—— 规则侧锚点无法重算，拒绝猜测最接近的条款`)
  }

  // --- The BINDING: this clause about this surface must really be a candidate -
  const bindings = toBindings(subject)
  if (bindings !== null && surfaceId !== null && !bindings.has(`${clauseId}\u0000${surfaceId}`)) {
    return unanchored('no-match',
      `候选集里没有 (条款 "${clauseId}", 受监管面 "${surfaceId}") 这一对绑定 —— 该条款的 appliesTo 并不管辖这个面，拒绝凭空建立绑定关系`)
  }

  const clauseEntry = clauses?.find((entry) => entry.id === clauseId) ?? null
  const clauseLabel = clauseId

  // --- EVIDENCE half (cont.): re-locate the excerpt -------------------------
  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent }
    : documents.find((document) => document.path === preferred) ?? null

  if (named !== null) {
    const declared = locator.startLine
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return anchored(named.path, declared, declared + needle.length - 1, 'declared-locator',
          `第 ${declared} 行确认无误（共 ${lineCount(named.content)} 行）；规则侧条款 ${clauseLabel} 已确认`, clauseLabel)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }
    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号；规则侧条款 ${clauseLabel} 已确认`, clauseLabel)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁`)
    }
    return unanchored('relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }

  const others = documents.filter((document) => document.path !== preferred)
  if (others.length === 0 && subjectContent === null) {
    return unanchored('no-match', `声明的 "${preferred}" 与任何可比对文档都不含这段原文`)
  }
  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return anchored(only.path, only.start, only.end, 'relocated-unique',
      `声明的 "${preferred}" 不在可比对文档中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁；规则侧条款 ${clauseLabel} 已确认`, clauseLabel)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对文档中，且原文在 ${hits.length} 处命中 —— 跨文件搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  return unanchored('no-match', `声明的 "${preferred}" 与任何可比对文档都不含这段原文`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '双锚点：条款 ID 在条款清单里重算 + 证据原文逐字滑窗定位。任一半缺失或矛盾即判未锚定并降级。',
  verify,
})

/** Re-exported for the domain's own tests and evidence tools. */
export { allMatches, matchesAt }
