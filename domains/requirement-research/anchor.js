/**
 * requirement-research — P5 anchor verifier (contract v2, extension point 2).
 *
 * WHAT AN ANCHOR IS HERE
 * ----------------------
 * `verbatim-and-timestamp`: the claim quotes an utterance word for word AND
 * names which turn (and, optionally, which timestamp) it came from. The engine
 * re-derives the location from the corpus; the model's turn number and
 * timestamp are treated as CLAIMS, not as facts.
 *
 * The document handed to this verifier is one session with ONE UTTERANCE PER
 * LINE (`{ path: 'sessions/s1', content, times: [...] }`), which is why a
 * verdict's `start`/`end` are turn numbers. That is deliberate: the corpus is
 * small, the mapping is total, and a line number that means "turn 7" can be
 * re-derived by a human in one look.
 *
 * THE TWO NEGATIVES THAT MUST NOT BE SOFTENED
 * -------------------------------------------
 *   • a PARAPHRASE never anchors. Whisper-normalised comparison only collapses
 *     whitespace; a changed word, a reordered clause, a tidied-up grammar is a
 *     different utterance. "用户说 A，所以其实是 B" produces an unanchored B.
 *   • a TURN NUMBER or TIMESTAMP that contradicts the corpus is refused, not
 *     repaired. That is the whole point of naming a turn: it is checkable.
 *
 * Degradation ladder: declared-locator / recomputed-unique / relocated-unique,
 * then locator-mismatch / relocation-ambiguous / no-match / empty-excerpt /
 * kind-mismatch / no-documents — the contract's tier vocabulary, unchanged.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

/** The anchor kind this domain verifies. */
const KIND = 'verbatim-and-timestamp'

/**
 * Collapse ALL whitespace; change nothing else.
 *
 * Deliberately NOT the diff-line normaliser used by code-review: that one also
 * strips a leading `+`/`-`, which for prose would let a markdown bullet the
 * model added (or dropped) pass as "the same words". A quote is a quote.
 */
function normalizeLine(line) {
  return String(line).replace(/\s+/gu, '')
}

function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

/** Every place `needle` appears (as a contiguous run of lines), overlapping included. */
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

/** Does the excerpt sit EXACTLY at turn `startLine`? */
export function matchesAt(content, needle, startLine) {
  const lines = String(content).split(/\r?\n/u)
  if (!Number.isInteger(startLine) || startLine < 1 || startLine + needle.length - 1 > lines.length) return false
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (normalizeLine(lines[startLine - 1 + offset]) !== needle[offset]) return false
  }
  return true
}

const unanchored = (tier, detail, extra = {}) => ({
  status: 'unanchored', tier, path: null, start: null, end: null, detail, ...extra,
})

const anchored = (path, start, end, tier, detail) => ({
  status: 'anchored', tier, path, start, end, ...(detail === undefined ? {} : { detail }),
})

/**
 * Normalise `subject.documents` into `[{ path, content, times }]`, tolerating
 * the `{ path, text }` spelling. `times[i]` is the timestamp of line `i + 1`;
 * when it is absent the timestamp half of the claim is simply not checkable and
 * the verdict says so instead of pretending it was checked.
 */
function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string' ? entry.content : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    const times = Array.isArray(entry.times) ? entry.times.map((value) => (value === null || value === undefined ? undefined : String(value))) : undefined
    documents.push({ path, content, times })
  }
  return documents
}

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,times?:string[],documents?:object[]}} subject
 * @returns {object} an AnchorVerdict — see the tier table at the top of the file
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt? }')
  }
  if (typeof claim.kind !== 'string' || claim.kind === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (typeof claim.path !== 'string' || claim.path === '') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`（应为 `sessions/<sessionId>`）')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可省略）')
  }

  if (claim.kind !== KIND) {
    return unanchored('kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }

  const locator = claim.locator ?? {}
  const declaredTurn = locator.utteranceIndex
  if (declaredTurn !== undefined && declaredTurn !== null && (!Number.isInteger(declaredTurn) || declaredTurn < 1)) {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, 'locator.utteranceIndex 必须是 >= 1 的整数（它是第几句，不是行号）')
  }

  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', '抄写的原话规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent, times: Array.isArray(subject?.times) ? subject.times.map(String) : undefined }
    : documents.find((document) => document.path === preferred) ?? null
  const others = documents.filter((document) => document.path !== preferred)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', '没有提供任何可比对的语料 —— 无法重算锚点')
  }

  if (named !== null) {
    if (Number.isInteger(declaredTurn) && declaredTurn >= 1) {
      if (!matchesAt(named.content, needle, declaredTurn)) {
        return unanchored('locator-mismatch',
          `按声明取 ${named.path} 第 ${declaredTurn} 句起的 ${needle.length} 句与抄写原话不符 —— 句号与原文矛盾，拒绝猜测，请重抄该句原文`)
      }
      const declaredT = locator.t
      const actualT = Array.isArray(named.times) ? named.times[declaredTurn - 1] : undefined
      if (declaredT !== undefined && declaredT !== null && actualT !== undefined && String(declaredT) !== actualT) {
        return unanchored('locator-mismatch',
          `第 ${declaredTurn} 句的原文对得上，但声明的时间戳 ${declaredT} 与语料中的 ${actualT} 不符 —— 时间戳与语料矛盾，同样判定未锚定`)
      }
      const stamp = actualT === undefined ? '（语料未提供 times，时间戳未能核验）' : `（时间戳 ${actualT} 已核验）`
      return anchored(named.path, declaredTurn, declaredTurn + needle.length - 1, 'declared-locator',
        `第 ${declaredTurn} 句原话逐字确认无误${stamp}`)
    }

    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 句），未采信模型给的句号`)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写原话在 ${named.path} 中逐字未命中；转述不算锚点，换句话说不算同一句话`)
    }
    return unanchored('relocation-ambiguous',
      `抄写原话在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
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
      `声明的 "${preferred}" 不在可比对语料中；原话在 "${only.path}" 跨场次唯一命中，发现已搬迁`)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对语料中，且原话在 ${hits.length} 处命中 —— 跨场次搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  return unanchored('no-match', `声明的 "${preferred}" 与任何可比对语料都不含这段原话`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '语料滑窗：只采信逐字抄写、且句号/时间戳与语料不矛盾的引用；转述、矛盾句号、跨场次歧义一律未锚定。',
  verify,
})
