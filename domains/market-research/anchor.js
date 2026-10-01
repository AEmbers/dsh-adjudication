/**
 * market-research — anchor verifier (contract v2, extension point 2).
 *
 * `verify` recomputes a claim's anchor from the inputs themselves. For this
 * domain a claim is anchored when BOTH hold:
 *
 *   1. its EVIDENCE STRENGTH is confirmed — the source it names exists, carries
 *      the strength the claim attributes to it, and the claim is not stronger
 *      than that source; and
 *   2. the QUOTED TEXT exists verbatim in the source card.
 *
 * Step 1 is the domain's own contribution and is deliberately checked BEFORE the
 * text ladder. A sentence can be quoted perfectly and still be laundered: the
 * vendor's blog post is 二手, the sentence quoting it is 一手, and the number
 * then travels onward without the qualifier. A verifier that only did string
 * matching would call that anchored.
 *
 * THE ONE TIER RULE
 * -----------------
 * `ANCHOR_TIERS` (lib/contracts.js) is closed — a domain may not invent a tier,
 * and an `unanchored` verdict may not carry a line number. So every
 * domain-specific refusal reason travels in the extra `code` field, next to the
 * standard tier:
 *
 *   strength-mismatch  the claim claims more strength than its source has
 *   unknown-source     the named source is not in the seed
 *   unknown-claim      the named claim is not on that source
 *   no-sources         no source registry was supplied (tier `no-documents`)
 *
 * 转述不锚定 AND 歧义拒绝猜测
 * --------------------------
 * The match is a normalized WHOLE-LINE comparison over a sliding window, so a
 * paraphrase never lands, no matter how close its numbers are; and when the same
 * line occurs in more than one source card the verdict is `relocation-ambiguous`
 * with every competing path listed in `ambiguousIn` — the verifier reports the
 * ambiguity instead of picking the most likely file.
 *
 * WHERE THE SOURCE REGISTRY COMES FROM
 * ------------------------------------
 * `adjudication_submit` can only hand a verifier `{path, content, document,
 * documents}`; there is no structured channel. So the seed's source list travels
 * as a convention document — `research/<…>.json` whose content is
 * `{ question, sources: [...], claims: [...] }` — exactly as the lineage graph
 * does for `data-engineering`. `subject.sources` is also accepted for direct
 * callers.
 *
 * HONESTY: the SOURCE data is the caller's; this file confirms internal
 * consistency of the seed (does the card say 二手 while the claim says 一手) and
 * the presence of the quoted line. It cannot confirm the source is TRUE. That is
 * stated in the returned `detail` rather than implied by an `anchored` status.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'
import {
  STRENGTH_LABELS,
  claimLine,
  normalizeStrength,
  overclaims,
  quoteLine,
  renderSource,
  strengthLine,
} from './source.js'

/**
 * A line normalised for comparison: leading list/diff markers removed, all runs
 * of whitespace folded to one space, ends trimmed.
 *
 * Whitespace is the only tolerated difference. Case, punctuation and every word
 * are compared exactly — a paraphrase that keeps the numbers still fails, which
 * is the point of the rule 「转述不算锚定」.
 */
function normalizeLine(line) {
  return String(line ?? '')
    .replace(/^\s*(?:[-+*>]+|\d+[.)])\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Every 1-based line number in `content` whose normalized form equals `target`. */
export function matchesAt(content, target) {
  const wanted = normalizeLine(target)
  if (wanted === '') return []
  const hits = []
  for (const [index, line] of String(content ?? '').split(/\r?\n/u).entries()) {
    if (normalizeLine(line) === wanted) hits.push(index + 1)
  }
  return hits
}

/** Every `(path, lines)` where the target line occurs. Exported for reuse. */
export function allMatches(documents, target) {
  const found = []
  for (const document of Array.isArray(documents) ? documents : []) {
    const hits = matchesAt(document?.content, target)
    if (hits.length > 0) found.push({ path: document?.path ?? null, hits })
  }
  return found
}

/** Is this document the structured source REGISTRY rather than a card to search? */
function isRegistryDocument(path) {
  return /^research\/.+\.json$/u.test(String(path ?? ''))
}

/**
 * Parse the registry out of `subject.sources`, a convention DOCUMENT, or the
 * subject's own `content` (the self-folded form).
 *
 * WHY THE THIRD FORM EXISTS: through `adjudication_anchor` the engine collapses
 * whatever the caller supplied into `{ path, content, document, documents }` — a
 * structured `subject.sources` field does not survive that trip. A caller that
 * hands the seed back as the subject document (path `research/<…>.json`, content
 * the JSON text) is handing back exactly the input material the review was based
 * on, so the domain must be able to read it back out of `content`. Not a bypass:
 * the parsed sources still go through the SAME strength recomputation, and an
 * unlabelled or overclaimed source is still refused.
 */
function registryOf(subject) {
  if (Array.isArray(subject?.sources)) {
    return { question: subject.question ?? null, sources: subject.sources, claims: subject.claims ?? [] }
  }
  for (const document of Array.isArray(subject?.documents) ? subject.documents : []) {
    if (!isRegistryDocument(document?.path)) continue
    try {
      const parsed = JSON.parse(String(document.content ?? ''))
      if (Array.isArray(parsed?.sources)) {
        return { question: parsed.question ?? null, sources: parsed.sources, claims: parsed.claims ?? [] }
      }
    } catch {
      return null
    }
  }
  if (typeof subject?.content === 'string' && subject.content.trim() !== '') {
    try {
      const parsed = JSON.parse(subject.content)
      if (Array.isArray(parsed?.sources)) {
        return { question: parsed.question ?? null, sources: parsed.sources, claims: parsed.claims ?? [] }
      }
    } catch {
      return null
    }
  }
  return null
}

/** The documents a text search may look at: cards only, never the registry. */
function searchableDocuments(subject) {
  const documents = []
  // The engine hands the same card twice: once as `subject.content` (the
  // document the finding named) and once inside `subject.documents`. Counting it
  // twice would make EVERY anchor look like a cross-file relocation ambiguity —
  // a verifier that refuses everything is as useless as one that guesses. So
  // identical (path, content) pairs collapse; two documents that merely share a
  // path but differ in content stay separate, because that IS ambiguous.
  const seen = new Set()
  const add = (path, content) => {
    const key = `${String(path ?? '')}\u0000${content}`
    if (seen.has(key)) return
    seen.add(key)
    documents.push({ path: path ?? null, content })
  }
  if (typeof subject?.content === 'string' && subject.content !== '') {
    add(subject.path ?? null, subject.content)
  }
  for (const document of Array.isArray(subject?.documents) ? subject.documents : []) {
    if (isRegistryDocument(document?.path)) continue
    if (typeof document?.content === 'string' && document.content !== '') {
      add(document.path ?? null, document.content)
    }
  }
  return documents
}

const unanchored = (tier, code, detail, extra = {}) => ({
  status: 'unanchored',
  tier,
  path: null,
  start: null,
  end: null,
  code,
  detail,
  ...extra,
})

export function verify(claim, subject = {}, _context = {}) {
  if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator, excerpt }')
  }
  if (claim.locator !== undefined && claim.locator !== null && typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（可为空对象）')
  }
  if (claim.kind !== undefined && claim.kind !== null && claim.kind !== 'source-quote') {
    return unanchored('kind-mismatch', 'kind-mismatch', `本域只验证 kind="source-quote" 的锚点，收到 "${claim.kind}"`)
  }
  const excerpt = String(claim.excerpt ?? '')
  if (excerpt.trim() === '') {
    return unanchored('empty-excerpt', 'empty-excerpt', '摘录为空：没有原文就不存在锚点')
  }

  const registry = registryOf(subject)
  if (registry === null) {
    return unanchored(
      'no-documents',
      'no-sources',
      '没有来源登记表：请把 seed 的 { question, sources, claims } 作为 research/<…>.json 文档随发现一起交回（或放在 subject.sources）',
    )
  }

  const locator = claim.locator ?? {}
  /**
   * Which layer of the domain this anchor confirms. A source candidate quotes
   * its STRENGTH line, a quote candidate its quotation, a claim candidate its
   * claim line — the code says which one, because `anchored` alone would not.
   */
  const confirmCode = locator.claimId === undefined || locator.claimId === null
    ? (locator.kind === 'source' ? 'strength-confirmed' : 'quote-confirmed')
    : 'claim-confirmed'
  const sourceId = String(locator.sourceId ?? '').trim()
  const documentPath = claim.path === undefined || claim.path === null ? null : String(claim.path)

  // Deleting a source does not delete the record of what was cited from it, so
  // even a withdrawn source is checked against the registry rather than skipped.
  const source = sourceId === ''
    ? null
    : registry.sources.find((entry) => String(entry?.id ?? '') === sourceId) ?? null

  // --- the seed-level (no locator) confirmation ------------------------------
  if (sourceId === '') {
    const cards = searchableDocuments(subject).filter((document) => String(document.content).includes('strength = '))
    const matches = allMatches(cards, excerpt)
    if (matches.length > 1) {
      return unanchored('relocation-ambiguous', 'relocation-ambiguous', `同一行出现在 ${matches.length} 份来源卡片里，无法判定它属于哪一份`, { ambiguousIn: matches.flatMap((hit) => hit.hits.map((line) => `${hit.path}:${line}`)) })
    }
    if (matches.length === 0) {
      return unanchored('no-match', 'no-match', '没有定位到这一行：链级确认需要摘录是某份来源卡片里逐字存在的一行')
    }
    const card = cards.find((document) => document.path === matches[0].path)
    const declared = /^strength = (\w+)/mu.exec(String(card.content))?.[1] ?? null
    return {
      status: 'anchored',
      tier: 'recomputed-unique',
      path: matches[0].path,
      start: matches[0].hits[0],
      end: matches[0].hits[0],
      code: 'source-confirmed',
      strength: declared,
      detail: `链级确认：摘录逐字存在于来源卡片，卡片声明的证据强度是 ${declared ?? '未知'}；未确认具体结论，也未确认来源本身为真`,
    }
  }

  const { strength: sourceStrength, declared: strengthDeclared } = normalizeStrength(source?.strength)
  const card = source === null ? null : renderSource(source, registry.claims.filter((entry) => String(entry?.sourceId ?? '') === sourceId))
  const claimEntry = locator.claimId === undefined || locator.claimId === null
    ? null
    : registry.claims.find((entry) => String(entry?.id ?? '') === String(locator.claimId)) ?? null

  // --- 1. the evidence-strength check runs FIRST ----------------------------
  if (source === null) {
    return unanchored('no-match', 'unknown-source', `来源 "${sourceId}" 不在 seed 的来源表里：无法确认它是一手、二手还是推测`, { knownSources: registry.sources.map((entry) => String(entry?.id ?? '')) })
  }
  if (String(locator.claimId ?? '') !== '' && claimEntry === null) {
    return unanchored('no-match', 'unknown-claim', `结论 "${String(locator.claimId)}" 不在来源 "${sourceId}" 的名下`)
  }
  if (claimEntry !== null) {
    const claimStrength = normalizeStrength(claimEntry.strength ?? source?.strength).strength
    if (overclaims(claimStrength, sourceStrength)) {
      return unanchored(
        'locator-mismatch',
        'strength-mismatch',
        `口径洗白：结论 "${String(claimEntry.id)}" 按「${STRENGTH_LABELS[claimStrength]}」引用，而来源 "${sourceId}" 只是「${STRENGTH_LABELS[sourceStrength]}」`
        + (strengthDeclared ? '' : '（来源未声明强度，按推测处理）'),
        { sourceStrength, claimStrength },
      )
    }
  }
  if (locator.strength !== undefined && locator.strength !== null) {
    const declared = normalizeStrength(locator.strength).strength
    if (declared !== sourceStrength) {
      return unanchored(
        'locator-mismatch',
        'strength-mismatch',
        `声明的证据强度「${STRENGTH_LABELS[declared]}」与来源表里的「${STRENGTH_LABELS[sourceStrength]}」不一致`,
        { sourceStrength, claimStrength: declared },
      )
    }
  }

  // --- 2. the verbatim text ladder ------------------------------------------
  const documents = searchableDocuments(subject)
  // A structured payload document is DATA, not prose: a JSON registry line must
  // never be able to relocate an excerpt because a string happens to match.
  const matches = allMatches(documents, excerpt)
  if (matches.length === 0) {
    return unanchored(
      'no-match',
      'no-match',
      `摘录在任何来源卡片里都不是逐字存在的一整行 —— 转述、改标点、改数字都不算锚定。来源 "${sourceId}" 的卡片路径是 ${documentPath ?? '(未声明)'}`,
      { sourceStrength },
    )
  }
  if (matches.length > 1) {
    return unanchored(
      'relocation-ambiguous',
      'relocation-ambiguous',
      `同一行出现在 ${matches.length} 份来源卡片里，拒绝猜测它属于哪一份`,
      { ambiguousIn: matches.flatMap((hit) => hit.hits.map((line) => `${hit.path}:${line}`)), sourceStrength },
    )
  }

  const hit = matches[0]
  if (documentPath !== null && hit.path !== null && hit.path !== documentPath) {
    // The unique other location is a relocation, not a contradiction: the text
    // exists exactly once and the verifier says where it really is.
    return {
      status: 'anchored',
      tier: 'relocated-unique',
      path: hit.path,
      start: hit.hits[0],
      end: hit.hits[0],
      code: locator.claimId === undefined || locator.claimId === null
        ? (locator.kind === 'source' ? 'strength-relocated' : 'quote-relocated')
        : 'claim-relocated',
      strength: sourceStrength,
      detail: `摘录声明的路径 ${documentPath} 上没有这一行，但它唯一存在于 ${hit.path}：按搬迁确认，行号以重算结果为准`,
    }
  }
  if (locator.startLine !== undefined && locator.startLine !== null) {
    const declaredStart = Number(locator.startLine)
    if (!Number.isInteger(declaredStart) || declaredStart !== hit.hits[0]) {
      return unanchored('locator-mismatch', 'locator-mismatch', `声明的行号 ${String(locator.startLine)} 与原文实际所在的第 ${hit.hits[0]} 行不一致`)
    }
    return {
      status: 'anchored',
      tier: 'declared-locator',
      path: hit.path,
      start: hit.hits[0],
      end: hit.hits[0],
      code: confirmCode,
      strength: sourceStrength,
      detail: `逐字命中且行号一致；证据强度「${STRENGTH_LABELS[sourceStrength]}」与来源表一致。锚点确认的是「原文如此引用」，不是「这个说法为真」`,
    }
  }

  return {
    status: 'anchored',
    tier: 'recomputed-unique',
    path: hit.path,
    start: hit.hits[0],
    end: hit.hits[0],
    code: confirmCode,
    strength: sourceStrength,
    detail: `逐字命中于第 ${hit.hits[0]} 行；证据强度「${STRENGTH_LABELS[sourceStrength]}」与来源表一致（${card === null ? '未渲染卡片' : '卡片已按同一约定渲染'}）。锚点确认的是「原文如此引用」，不是「这个说法为真」`,
  }
}

/** Exported so the pack's `anchor.verify` and the test agree on one name. */
export const verifyLevel = 'engine-recomputable'

/** For callers that want the card exactly as the verifier renders it. */
export { renderSource, strengthLine, quoteLine, claimLine }

export default defineAnchorVerifier({
  kind: 'source-quote',
  verifyLevel: 'engine-recomputable',
  verify,
  describe: '先重算证据强度（来源是否存在、结论是否比来源更强），再在来源卡片里逐字滑窗定位引文；转述不锚定，同一行命中多份卡片时拒绝猜测并列出全部候选路径。',
})
