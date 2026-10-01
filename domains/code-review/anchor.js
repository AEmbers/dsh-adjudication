/**
 * code-review — P5 anchor verifier (contract v2, extension point 2).
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * The model NEVER supplies a line number that is taken on trust. It copies the
 * text it wants to comment on; the engine rediscovers where that text lives.
 * This file is the rediscovery, and its most important output is the word
 * `unanchored`.
 *
 * Degradation ladder, verbatim from the v1 pack description and open-code-review
 * `internal/diff/resolver.go`:
 *
 *   declared-locator    the claim's line range was confirmed: the excerpt really
 *                       is at the line the model named. (tier 1)
 *   recomputed-unique   no line number, or the line number was not usable, and
 *                       the excerpt resolves to exactly ONE place in the named
 *                       document. (tier 1')
 *   relocated-unique    the named document does not hold it, but exactly ONE
 *                       other document does; the finding moves there. (tier 2)
 *   locator-mismatch    the model named a line and the excerpt is NOT there.
 *                       Terminal. A claim that contradicts the input is not
 *                       repaired by guessing where it "probably" meant. (tier 3)
 *   relocation-ambiguous  two or more equally valid locations. Terminal, and
 *                       the competing locations are listed. (tier 3)
 *   no-match / empty-excerpt / kind-mismatch / no-documents  terminal.
 *
 * `locator-mismatch` and `relocation-ambiguous` are the two negative cases the
 * domain's `test.mjs` must prove, and they are the two that a "make the anchor
 * rate look good" reflex would be tempted to soften. They are not softened here.
 *
 * MATCHING IS LITERAL. `normalizeLine` drops the diff marker and ALL whitespace
 * (ported from `resolver.go:301`), which is exactly the tolerance a re-indented
 * or CRLF-shuffled paste needs. Nothing else is tolerated: a paraphrase, a
 * renamed identifier, a changed punctuation mark is a DIFFERENT line, and the
 * verifier says so rather than scoring a near miss. That is what makes the
 * anchor independently re-checkable by a human.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

/**
 * Strip a diff marker and ALL whitespace — the comparison form of one line.
 *
 * This is open-code-review `internal/diff/resolver.go:301 normalizeLine`,
 * reproduced here rather than imported so the comparison rule the anchor stands
 * on is readable in the same file as the ladder that uses it. It is four lines
 * and it has exactly one behaviour; a shared indirection would only make the
 * "what counts as the same line" question harder to audit.
 */
function normalizeLine(line) {
  return String(line).replace(/^[+-]/u, '').replace(/\s+/gu, '')
}

/** Normalise an excerpt into its comparison lines. Blank lines are dropped. */
function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

/** The anchor kind this domain verifies. Declared before use, deliberately. */
const KIND = 'diff-line'

/** Claim `locator.side` for a diff-line claim. Only the added side is verified. */
const SIDES = Object.freeze(['new', 'old'])

const lineCount = (content) => String(content).split(/\r?\n/u).length

/**
 * All places `needle` appears in `content`, as 1-based inclusive spans.
 * The window is searched at every offset (overlapping included) — a duplicated
 * line inside one hunk is a real ambiguity, not a rounding error.
 */
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
  detail,
  ...extra,
})

const anchored = (path, start, end, tier, detail) => ({
  status: 'anchored',
  tier,
  path,
  start,
  end,
  ...(detail === undefined ? {} : { detail }),
})

/**
 * Normalise `subject.documents` into `[{ path, content }]`, tolerating the
 * `{ path, text }` spelling a caller may reach for.
 */
function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string' ? entry.content : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    documents.push({ path, content, index })
  }
  return documents
}

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:Array<{path:string,content:string}>}} subject
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
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可省略）')
  }

  if (claim.kind !== KIND) {
    return unanchored('kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }

  const locator = claim.locator ?? {}
  if (locator.side !== undefined && !SIDES.includes(locator.side)) {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, `locator.side 必须是 ${SIDES.join('/')} 之一`)
  }

  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', '抄写的原文规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null

  // The named document is either the subject's own content, or its entry in the
  // document set.
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent, index: -1 }
    : documents.find((document) => document.path === preferred) ?? null

  const others = documents.filter((document) => document.path !== preferred)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', '没有提供任何可比对的文档内容 —— 无法重算锚点')
  }

  if (named !== null) {
    const declared = locator.startLine
    if (Number.isInteger(declared) && declared >= 1) {
      // The model named a line. Either it is telling the truth about that line
      // or the claim is broken — never "close enough".
      if (matchesAt(named.content, needle, declared)) {
        return anchored(named.path, declared, declared + needle.length - 1, 'declared-locator',
          `第 ${declared} 行确认无误（共 ${lineCount(named.content)} 行）`)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }

    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号`)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁`)
    }
    return unanchored('relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }
  // The named document is absent from the set: relocate, but only on a hit that
  // is unique across EVERY other document.
  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return anchored(only.path, only.start, only.end, 'relocated-unique',
      `声明的 "${preferred}" 不在可比对文档中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁`)
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
  describe: 'diff 行滑窗：只采信逐字抄写的原文，行号一律重算；歧义或矛盾时返回未锚定并降级。',
  verify,
})

/** Re-exported for the domain's own tests and evidence tools. */
export { allMatches, matchesAt }
