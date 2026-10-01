/**
 * user-feedback — P5 anchor verifier (contract v2, extension point 2).
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * The engine, not the model, decides whether a feedback item is closed, whether a
 * decision addresses anything, and whether a quoted sentence is really in the
 * ledger. The model never supplies a fact about the ledger that is taken on trust.
 * The most important word this file produces is `unanchored`.
 *
 * WHY A CLOSURE NEEDS BOTH SIDES
 * ------------------------------
 * A closure is real only when the decision's `addresses` and the feedback's
 * `closedBy` agree. One side alone is the domain's signature defect — a ticket
 * marked closed that the decision record never mentions, or a decision claiming to
 * handle feedback whose entry still reads `open` — and both are invisible to a
 * reader who looks at one side at a time. So `closure-link` is confirmed only on
 * MUTUAL agreement; one-sided is `locator-mismatch`, never a downgraded pass. The
 * refusal is what makes "closed" a fact rather than a claim.
 *
 * THE CLAIM KINDS
 * ---------------
 *   closure-link          `{feedbackId, decisionId}` — "this item is closed by that
 *                         decision". Confirmed only when BOTH spellings agree.
 *   unclosed-feedback     `{feedbackId}` — "nothing closes this item". Confirmed only
 *                         when no decision names it and it names no decision.
 *   orphan-decision       `{decisionId}` — "this decision addresses nothing".
 *   quote-anchor          `{feedbackId?, quote}` — "the ledger says this, verbatim".
 *                         A PARAPHRASE NEVER ANCHORS. With no `feedbackId` the
 *                         verifier must also work out WHICH record the quote belongs
 *                         to, and refuses when that is not unique.
 *   theme-membership      `{themeId, feedbackId}` — "this item belongs to that
 *                         theme". Both spellings must agree, same as a closure.
 *   unregistered-reference `{referencedId, referrerId}` — "the ledger links to an id
 *                         that does not exist". The broken-link shape.
 *
 * TIER INFERENCE — THE JUDGEMENT THE CAPTAIN RULED ON
 * --------------------------------------------------
 * `declared-locator` means **the locator the CALLER supplied was independently
 * confirmed by this verifier**, NOT "the engine announced it". An earlier version of
 * the sibling domain read a `claim.declared` flag that nothing ever set, which
 * silently demoted every confirmed claim to `recomputed-unique` — a tier whose
 * contract meaning is "the locator was missing or wrong and the verifier had to
 * re-derive the position". So:
 *
 *   the locator carries what this domain needs  -> the caller declared WHICH thing it
 *                                                  means and the ledger confirms it
 *                                                  -> declared-locator
 *   the locator carries only a quote/position    -> the verifier has to work out
 *                                                  which record is meant, uniquely
 *                                                  -> recomputed-unique
 *
 * `quote-anchor` with a bare `quote` is the case that makes the second tier honest
 * and reachable here: the caller quoted the ledger but did not say which record it
 * came from, so the verifier resolves the identity itself and refuses when two
 * records both contain the quote.
 *
 * MATCHING IS EXACT. Quotes are compared as whitespace-collapsed text, case
 * preserved; nothing else is normalised. There is no fuzzy match, no synonym
 * table, and no "close enough" — a summary of a bug report is not the bug report.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'
import {
  anchored,
  declarationsOf,
  documentByPath,
  graphDocuments,
  relocate,
  slash,
  unanchored,
} from '../_lib/graph.js'
import {
  MIN_QUOTE_CHARS,
  declaredIds,
  linkKey,
  linkPairs,
  linkSides,
  normalizeQuote,
  populations,
  themeOf,
} from './source.js'

/** The anchor kind this domain declares in `index.js`. */
const KIND = 'feedback-and-quote'

/** The claim shapes `locator.kind` may take. Exported for the tests. */
export const ANCHOR_KINDS = Object.freeze([
  'closure-link',
  'one-sided-closure',
  'unclosed-feedback',
  'orphan-decision',
  'quote-anchor',
  'theme-membership',
  'one-sided-theme',
  'unregistered-reference',
])

/**
 * Why BOTH a positive and a negative form of the same relation exist.
 *
 * `closure-link` asserts a mutual closure and is REFUSED when the ledger only
 * declares one side. That refusal is the correct verdict for the claim "this item is
 * closed" — but it leaves the domain's most important finding unanchorable. The
 * finding is not "this is closed"; it is "this is closed on ONE side only", and a
 * verifier with no vocabulary for that can only ever report it as text prose, which
 * is exactly what this program exists to eliminate.
 *
 * So the partial states get their own kinds. `one-sided-closure` is confirmed when
 * EXACTLY ONE of the two spellings exists, and refused when both exist (the closure
 * is real) or when neither does (there is no relation to be partial about). The same
 * argument applies to `theme-membership` / `one-sided-theme`.
 *
 * The result is that every verdict this domain produces is a FACT about the ledger,
 * and no finding class depends on the reviewer's prose.
 */

/**
 * The tiers this verifier can actually return, for the domain's completeness check.
 *
 * Every name must be a tier `lib/contracts.js` declares — the earlier sibling domain
 * learned that the hard way (`empty-claim` is not a tier; the contract's name for
 * "nothing to match" is `empty-excerpt`).
 */
export const REACHABLE_TIERS = Object.freeze([
  'declared-locator', 'recomputed-unique', 'relocated-unique',
  'locator-mismatch', 'relocation-ambiguous', 'no-match',
  'empty-excerpt', 'kind-mismatch', 'no-documents',
])

/** The extension tier name for "the same id names two different things". */
export const ID_AMBIGUOUS = 'id-ambiguous'

/** What each claim kind needs in the locator before it counts as declared. */
const REQUIRED_FIELDS = Object.freeze({
  'closure-link': ['feedbackId', 'decisionId'],
  'one-sided-closure': ['feedbackId', 'decisionId'],
  'unclosed-feedback': ['feedbackId'],
  'orphan-decision': ['decisionId'],
  'theme-membership': ['themeId', 'feedbackId'],
  'one-sided-theme': ['themeId', 'feedbackId'],
  'unregistered-reference': ['referencedId', 'referrerId'],
})

const isText = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Does the caller's locator name the claim's constituents ITSELF?
 *
 * `quote-anchor` is deliberately absent from `REQUIRED_FIELDS`: a quote alone is a
 * complete CLAIM but not a complete LOCATOR, and that difference is exactly the
 * `declared-locator` / `recomputed-unique` boundary. See the header.
 */
export function constituentsDeclared(kind, locator) {
  if (locator === null || typeof locator !== 'object') return false
  if (kind === 'quote-anchor') return isText(locator.feedbackId) && normalizeQuote(locator.quote).length >= MIN_QUOTE_CHARS
  const fields = REQUIRED_FIELDS[kind]
  return fields === undefined ? false : fields.every((field) => isText(locator[field]))
}

/** Every fact the verifier needs about one ledger document, derived once. */
function analyse(document) {
  const { feedback, decisions, themes, feedbackById, decisionById, themeById } = populations(document)
  const sides = linkSides(document)
  const linked = new Set()
  for (const side of sides.values()) {
    linked.add(side.feedbackId)
    linked.add(side.decisionId)
  }
  return {
    path: document.path,
    document,
    feedback,
    decisions,
    themes,
    feedbackById,
    decisionById,
    themeById,
    sides,
    links: linkPairs(document),
    declared: declaredIds(document),
    linked,
    /** Is `id` a feedback record here? */
    isFeedback: (id) => feedbackById.has(String(id)),
    /** Is `id` a decision record here? */
    isDecision: (id) => decisionById.has(String(id)),
    /** Is `id` a theme here? */
    isTheme: (id) => themeById.has(String(id)),
    /** Is `id` declared anywhere in this document? */
    knows: (id) => declaredIds(document).includes(String(id)),
    /** Links touching a feedback id, in declaration order. */
    linksOfFeedback: (id) => [...sides.values()].filter((side) => side.feedbackId === String(id)),
    /** Links touching a decision id, in declaration order. */
    linksOfDecision: (id) => [...sides.values()].filter((side) => side.decisionId === String(id)),
    /** The side record for a pair, or null. */
    sidesOf: (decisionId, feedbackId) => sides.get(linkKey(decisionId, feedbackId)) ?? null,
  }
}

/** Describe one side record compactly, for a refusal message. */
function describeSide(side) {
  if (side.addresses && side.closedBy) return `决策 ${side.decisionId} 与反馈 ${side.feedbackId} 双侧互证`
  if (side.addresses) return `只有决策 ${side.decisionId} 的 addresses 声明（反馈 ${side.feedbackId} 的 closedBy 没指向它）`
  if (side.closedBy) return `只有反馈 ${side.feedbackId} 的 closedBy 声明（决策 ${side.decisionId} 的 addresses 没提到它）`
  return `决策 ${side.decisionId} 与反馈 ${side.feedbackId} 之间没有任何声明`
}

/** The first index at which two strings differ, or -1. Used to explain a paraphrase. */
function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length)
  for (let index = 0; index < limit; index += 1) if (a[index] !== b[index]) return index
  return a.length === b.length ? -1 : limit
}

/**
 * Resolve the two ids of a closure claim against this ledger.
 *
 * @returns {{ mismatch: {tier,conflict} }|{ unknown: true }|{ side: object|null }}
 *   a contradiction, an absence, or the side record.
 */
function closureSides(graph, locator) {
  const feedbackId = String(locator.feedbackId ?? '')
  const decisionId = String(locator.decisionId ?? '')
  if (isText(feedbackId) && !graph.isFeedback(feedbackId)) {
    // The id exists in the ledger but as something else. That is a contradiction, not
    // an absence: the ledger has that name, and it is not a feedback record.
    if (graph.knows(feedbackId)) {
      return { mismatch: { tier: 'locator-mismatch', conflict: `"${feedbackId}" 在台账里不是一个反馈 ID（它是决策或主题），角色错位 —— 无法当作反馈来验证闭环` } }
    }
    return { unknown: true }
  }
  if (isText(decisionId) && !graph.isDecision(decisionId)) {
    if (graph.knows(decisionId)) {
      return { mismatch: { tier: 'locator-mismatch', conflict: `"${decisionId}" 在台账里不是一个决策 ID（它是反馈或主题），角色错位 —— 无法当作决策来验证闭环` } }
    }
    return { unknown: true }
  }
  return { side: graph.sidesOf(decisionId, feedbackId) }
}

/**
 * Verify a claim against ONE analysed ledger.
 *
 * @returns {{ tier: string, hit: object }|{ tier: string, conflict: string }|null}
 *   a confirmation, a contradiction, or `null` when the ledger neither holds nor
 *   refutes the claim (which is what makes relocation possible).
 */
function against(graph, claim) {
  const locator = claim.locator ?? {}
  const kind = locator.kind

  if (kind === 'closure-link' || kind === 'one-sided-closure') {
    const resolved = closureSides(graph, locator)
    if (resolved.mismatch !== undefined) return resolved.mismatch
    if (resolved.unknown === true) return null
    const side = resolved.side
    if (side === null) return null
    const mutual = side.addresses && side.closedBy

    if (kind === 'closure-link') {
      if (mutual) return { tier: 'declared-locator', hit: { feedbackId: side.feedbackId, decisionId: side.decisionId, mutual: true } }
      return {
        tier: 'locator-mismatch',
        conflict: `闭环不成立：${describeSide(side)} —— 单边声明不算闭环，拒绝按「大概已经修了」放行`,
      }
    }

    // `one-sided-closure` asserts the PARTIAL state. It is the claim that lets this
    // domain anchor its signature defect, which `closure-link` can only refuse.
    if (mutual) {
      return {
        tier: 'locator-mismatch',
        conflict: `决策 ${side.decisionId} 与反馈 ${side.feedbackId} 是**双侧互证**的闭环，不是单边声明 —— 声称它只有单边与台账相反`,
      }
    }
    return {
      tier: 'declared-locator',
      hit: { feedbackId: side.feedbackId, decisionId: side.decisionId, side: side.addresses ? 'addresses-only' : 'closed-by-only' },
    }
  }

  if (kind === 'unclosed-feedback') {
    const feedbackId = String(locator.feedbackId ?? '')
    if (!graph.isFeedback(feedbackId)) return null
    const links = graph.linksOfFeedback(feedbackId)
    if (links.length === 0) return { tier: 'declared-locator', hit: { feedbackId } }
    return {
      tier: 'locator-mismatch',
      conflict: `反馈 ${feedbackId} 并不是无人处理：${links.map(describeSide).join('；')}`,
    }
  }

  if (kind === 'orphan-decision') {
    const decisionId = String(locator.decisionId ?? '')
    if (!graph.isDecision(decisionId)) return null
    const links = graph.linksOfDecision(decisionId)
    if (links.length === 0) return { tier: 'declared-locator', hit: { decisionId } }
    return {
      tier: 'locator-mismatch',
      conflict: `决策 ${decisionId} 并不是孤儿：${links.map(describeSide).join('；')}`,
    }
  }

  if (kind === 'quote-anchor') {
    const feedbackId = isText(locator.feedbackId) ? String(locator.feedbackId) : null
    const wanted = normalizeQuote(locator.quote)
    if (wanted.length === 0) return { tier: 'empty-excerpt', conflict: 'quote-anchor 缺少 quote —— 没有任何可核验的原文' }
    if (wanted.length < MIN_QUOTE_CHARS) {
      return { tier: 'empty-excerpt', conflict: `引文只有 ${wanted.length} 个字符（下限 ${MIN_QUOTE_CHARS}）：这么短的片段能匹配到任意多条记录，不构成锚点` }
    }
    if (feedbackId === null) return null // handled by recompute()
    if (!graph.isFeedback(feedbackId)) return null
    const recorded = normalizeQuote(graph.feedbackById.get(feedbackId)?.quote)
    if (recorded.includes(wanted)) return { tier: 'declared-locator', hit: { feedbackId, quote: wanted } }
    // Verbatim or nothing. The refusal explains HOW it differs, because "the quote
    // is not in the ledger" is not actionable and "you changed the wording at
    // offset 12" is.
    const at = firstDifference(recorded, wanted)
    return {
      tier: 'locator-mismatch',
      conflict: `引文与反馈 ${feedbackId} 记录的原文不一致（首个差异在第 ${at < 0 ? '末尾' : at + 1} 个字符）—— **转述不是原话**，未锚定`,
    }
  }

  if (kind === 'theme-membership' || kind === 'one-sided-theme') {
    const themeId = String(locator.themeId ?? '')
    const feedbackId = String(locator.feedbackId ?? '')
    if (!graph.isFeedback(feedbackId) || !graph.isTheme(themeId)) return null
    const tagged = themeOf(graph.feedbackById.get(feedbackId)) === themeId
    const listed = (Array.isArray(graph.themeById.get(themeId)?.members) ? graph.themeById.get(themeId).members : [])
      .map(String).includes(feedbackId)

    if (kind === 'theme-membership') {
      if (tagged && listed) return { tier: 'declared-locator', hit: { themeId, feedbackId, tagged: true, listed: true } }
      if (!tagged && !listed) return null
      return {
        tier: 'locator-mismatch',
        conflict: `主题归属只有单边声明：${tagged ? `反馈 ${feedbackId} 的 theme 是 "${themeId}"` : `反馈 ${feedbackId} 的 theme 不是 "${themeId}"`}，`
          + `${listed ? `主题 ${themeId} 的 members 里有它` : `主题 ${themeId} 的 members 里没有它`} —— 两侧必须一致才算成立`,
      }
    }

    if (!tagged && !listed) return null
    if (tagged && listed) {
      return {
        tier: 'locator-mismatch',
        conflict: `反馈 ${feedbackId} 与主题 ${themeId} 是**双侧一致**的归属，不是单边声明 —— 声称它只有单边与台账相反`,
      }
    }
    return {
      tier: 'declared-locator',
      hit: { themeId, feedbackId, side: tagged ? 'tagged-only' : 'listed-only' },
    }
  }

  if (kind === 'unregistered-reference') {
    const referencedId = String(locator.referencedId ?? '')
    const referrerId = String(locator.referrerId ?? '')
    // The `knows` check comes FIRST, and the order is the point: an id that the ledger
    // DOES declare refutes the claim whether or not it also carries links. Checking
    // link membership first would report `no-match` ("the ledger cannot speak to
    // this") for a claim the ledger can in fact refute — the weakest kind of wrong
    // answer, because it invites a retry instead of a correction.
    if (graph.knows(referencedId)) {
      return {
        tier: 'locator-mismatch',
        conflict: `"${referencedId}" 在台账里是有记录的（不是失效链接）—— 声称它未登记与事实相反`,
      }
    }
    if (!graph.linked.has(referencedId)) return null
    const sides = [...graph.sides.values()].filter((side) => side.feedbackId === referencedId || side.decisionId === referencedId)
    if (isText(referrerId) && !sides.some((side) => side.feedbackId === referrerId || side.decisionId === referrerId)) return null
    return { tier: 'declared-locator', hit: { referencedId, referrerId: referrerId === '' ? null : referrerId } }
  }

  return { tier: 'kind-mismatch', conflict: `未定义的 locator.kind "${String(kind)}"，本域只认 ${ANCHOR_KINDS.join('/')}` }
}

/** Turn a confirmation into the shared verdict shape. */
function confirm(kind, graph, hit, tier, detail, scope = 'single-graph') {
  const extra = { scope }
  const base = { path: graph.path, tier, claim: kind, detail, extra }
  if (kind === 'closure-link' || kind === 'one-sided-closure') {
    return anchored({
      ...base, start: 1, end: 1, position: 'link', nodes: [hit.feedbackId, hit.decisionId],
      extra: {
        ...extra,
        ledger: {
          feedbackId: hit.feedbackId, decisionId: hit.decisionId,
          // `mutual` is a fact, not a label: a reader must be able to tell which of the
          // two claims was confirmed without re-reading the claim.
          mutual: hit.mutual === true,
          ...(hit.side === undefined ? {} : { side: hit.side }),
        },
      },
    })
  }
  if (kind === 'unregistered-reference') {
    return anchored({
      ...base, start: 1, end: 1, position: 'node', nodes: [hit.referencedId],
      extra: { ...extra, ledger: { referencedId: hit.referencedId, referrerId: hit.referrerId, dangling: true } },
    })
  }
  if (kind === 'quote-anchor') {
    return anchored({
      ...base, start: 1, end: 1, position: 'quote', nodes: [hit.feedbackId],
      extra: { ...extra, ledger: { feedbackId: hit.feedbackId, quote: hit.quote } },
    })
  }
  if (kind === 'theme-membership' || kind === 'one-sided-theme') {
    return anchored({
      ...base, start: 1, end: 1, position: 'node', nodes: [hit.themeId, hit.feedbackId],
      extra: {
        ...extra,
        ledger: {
          themeId: hit.themeId, feedbackId: hit.feedbackId,
          mutual: hit.tagged === true && hit.listed === true,
          ...(hit.side === undefined ? {} : { side: hit.side }),
        },
      },
    })
  }
  const id = hit.feedbackId ?? hit.decisionId
  return anchored({
    ...base, start: 1, end: 1, position: 'node', nodes: [id],
    extra: { ...extra, ledger: hit.feedbackId === undefined ? { decisionId: hit.decisionId } : { feedbackId: hit.feedbackId } },
  })
}

/** Turn a refusal into the shared verdict shape. */
function refuse(kind, tier, detail, extra = {}) {
  // `unanchored` names `ambiguousIn` as its own parameter and spreads the rest from
  // `extra`, so an arbitrary field passed in the top level would be silently dropped.
  // `scope` is the field this domain uses to keep an EXTENSION cause distinguishable
  // from the contract's own `relocation-ambiguous`, so it has to survive the call.
  const { ambiguousIn, ...rest } = extra
  return unanchored({
    tier, detail, claim: kind,
    ...(ambiguousIn === undefined ? {} : { ambiguousIn }),
    extra: rest,
  })
}

/** Does `excerpt` mention `id` as a WHOLE id, not as a substring of a longer one? */
function mentions(excerpt, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'u').test(excerpt)
}

/**
 * Re-derive an undeclared claim, over the whole corpus.
 *
 * Two real paths, both of which reach `recomputed-unique` honestly:
 *
 *   • `quote-anchor` with a bare `quote` — the caller quoted the ledger but did not
 *     say which record it came from. The verifier resolves the identity itself and
 *     confirms only when EXACTLY ONE record's quote contains it; two or more means
 *     the quote does not identify anything, and the competitors are listed.
 *   • any id-shaped kind with an `excerpt` instead of ids — the verifier reads the
 *     ids out of the excerpt and checks that the resulting claim holds in exactly
 *     one place.
 */
function recompute(claim, kind, documents) {
  const locator = claim.locator ?? {}
  const excerpt = typeof claim.excerpt === 'string' ? claim.excerpt : ''

  if (kind === 'quote-anchor') {
    const wanted = normalizeQuote(locator.quote)
    if (wanted.length === 0) {
      return refuse(kind, 'empty-excerpt', 'quote-anchor 没有 quote，也没有任何可核验的原文 —— 声明是空的')
    }
    if (wanted.length < MIN_QUOTE_CHARS) {
      return refuse(kind, 'empty-excerpt', `引文只有 ${wanted.length} 个字符（下限 ${MIN_QUOTE_CHARS}），无法唯一确定一条记录`)
    }
    const hits = []
    for (const document of documents) {
      const graph = analyse(document)
      for (const item of graph.feedback) {
        if (!isText(item?.id)) continue
        if (normalizeQuote(item.quote).includes(wanted)) hits.push({ graph, where: `${document.path}#feedback:${item.id}`, hit: { feedbackId: String(item.id), quote: wanted } })
      }
    }
    if (hits.length === 0) {
      return refuse(kind, 'no-match', '这段引文在台账的任何一条反馈原话里都找不到逐字出现的位置')
    }
    if (hits.length > 1) {
      return refuse(kind, 'relocation-ambiguous',
        `这段引文在 ${hits.length} 条反馈里都逐字出现，声明没有说明是哪一条 —— 拒绝挑一个交差`,
        { ambiguousIn: hits.map((entry) => entry.where).sort() })
    }
    const [only] = hits
    return confirm(kind, only.graph, only.hit, 'recomputed-unique',
      `locator 只给了引文、没有 feedbackId；引擎重算出唯一包含这段引文的记录（${only.where}）`)
  }

  if (excerpt.trim() === '') {
    return refuse(kind, 'empty-excerpt',
      `locator 缺少本域所需的字段（${(REQUIRED_FIELDS[kind] ?? ['quote']).join(' / ')}），也没有附 excerpt 供引擎重算 —— 声明是空的`)
  }

  const hits = []
  for (const document of documents) {
    const graph = analyse(document)
    if (kind === 'closure-link' || kind === 'one-sided-closure') {
      for (const [decisionId, feedbackId] of graph.links) {
        if (!mentions(excerpt, decisionId) || !mentions(excerpt, feedbackId)) continue
        const side = graph.sidesOf(decisionId, feedbackId)
        const mutual = side?.addresses === true && side?.closedBy === true
        const wanted = kind === 'closure-link' ? mutual : !mutual
        if (!wanted) continue
        hits.push({
          graph,
          where: `${document.path}#closure:${feedbackId}->${decisionId}`,
          hit: { feedbackId, decisionId, mutual, ...(mutual ? {} : { side: side?.addresses === true ? 'addresses-only' : 'closed-by-only' }) },
        })
      }
      continue
    }
    if (kind === 'unclosed-feedback') {
      for (const item of graph.feedback) {
        const id = String(item?.id ?? '')
        if (id === '' || !mentions(excerpt, id)) continue
        if (graph.linksOfFeedback(id).length === 0) hits.push({ graph, where: `${document.path}#feedback:${id}`, hit: { feedbackId: id } })
      }
      continue
    }
    if (kind === 'orphan-decision') {
      for (const decision of graph.decisions) {
        const id = String(decision?.id ?? '')
        if (id === '' || !mentions(excerpt, id)) continue
        if (graph.linksOfDecision(id).length === 0) hits.push({ graph, where: `${document.path}#decision:${id}`, hit: { decisionId: id } })
      }
      continue
    }
    if (kind === 'theme-membership' || kind === 'one-sided-theme') {
      for (const theme of graph.themes) {
        const themeId = String(theme?.id ?? '')
        if (themeId === '' || !mentions(excerpt, themeId)) continue
        for (const item of graph.feedback) {
          const feedbackId = String(item?.id ?? '')
          if (feedbackId === '' || !mentions(excerpt, feedbackId)) continue
          const tagged = themeOf(item) === themeId
          const listed = (Array.isArray(theme.members) ? theme.members : []).map(String).includes(feedbackId)
          const mutual = tagged && listed
          const wanted = kind === 'theme-membership' ? mutual : (tagged !== listed)
          if (!wanted) continue
          hits.push({
            graph,
            where: `${document.path}#theme:${themeId}/${feedbackId}`,
            hit: { themeId, feedbackId, tagged, listed, ...(mutual ? {} : { side: tagged ? 'tagged-only' : 'listed-only' }) },
          })
        }
      }
      continue
    }
    if (kind === 'unregistered-reference') {
      for (const id of graph.linked) {
        if (graph.knows(id) || !mentions(excerpt, id)) continue
        const side = [...graph.sides.values()].find((entry) => entry.feedbackId === id || entry.decisionId === id)
        const referrerId = side === undefined ? null : (side.feedbackId === id ? side.decisionId : side.feedbackId)
        hits.push({ graph, where: `${document.path}#dangling:${id}`, hit: { referencedId: id, referrerId } })
      }
    }
  }

  if (hits.length === 0) {
    return refuse(kind, 'no-match', `摘录没有唯一对应到任何一条 ${kind} —— 摘录里提到的 ID 在台账上找不到能成立的那种关系`)
  }
  if (hits.length > 1) {
    return refuse(kind, 'relocation-ambiguous',
      `摘录在 ${hits.length} 处都能成立，声明没有唯一确定是哪一处 —— 拒绝猜测`,
      { ambiguousIn: hits.map((entry) => entry.where).sort() })
  }
  const [only] = hits
  return confirm(kind, only.graph, only.hit, 'recomputed-unique',
    `locator 未给出本域所需字段；引擎从摘录重算出唯一成立的 ${kind}（${only.where}）`)
}

/**
 * Verify one anchor claim.
 *
 * @param {{kind?:string, path?:string, locator?:object, excerpt?:string}} claim
 * @param {{path?:string, documents?:Array}} subject
 * @returns {object} an AnchorVerdict
 */
export function verify(claim, subject) {
  if (claim === null || typeof claim !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明必须是对象 { kind, path, locator }')
  }
  if (!isText(claim.kind)) {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `kind`')
  }
  if (!isText(claim.path)) {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '锚点声明缺少字符串字段 `path`（它指向反馈台账文档）')
  }
  if (claim.locator === undefined || claim.locator === null || typeof claim.locator !== 'object') {
    throw contractError(ERROR_CODES.E_ANCHOR_CONTRACT, '`locator` 必须是对象（本域的锚点没有其它形态）')
  }
  if (claim.kind !== KIND) {
    return refuse(claim.locator?.kind ?? null, 'kind-mismatch', `本领域只验证 "${KIND}" 锚点，收到 "${claim.kind}"`)
  }
  if (!ANCHOR_KINDS.includes(claim.locator.kind)) {
    return refuse(claim.locator.kind ?? null, 'kind-mismatch', `未知的 locator.kind "${String(claim.locator.kind)}"，只认 ${ANCHOR_KINDS.join('/')}`)
  }

  const documents = graphDocuments(subject)
  if (documents.length === 0) {
    return refuse(claim.locator.kind, 'no-documents', '没有提供任何反馈台账文档 —— 锚点无法重算')
  }

  const claimKind = claim.locator.kind
  const wantedPath = slash(subject?.path !== undefined && subject.path !== '' ? subject.path : claim.path)

  // TIER INFERENCE FIRST. A locator that does not carry this domain's fields has
  // declared no relationship — only a quote or an excerpt — so there is nothing for
  // the ledger to confirm yet. See `constituentsDeclared`.
  if (!constituentsDeclared(claimKind, claim.locator)) {
    return recompute(claim, claimKind, documents)
  }

  // Identity before relationship: while two different records share one id, no
  // statement about that id means anything. Both collision shapes are refusals —
  // the same string declared by two documents, and the same string declared by two
  // POPULATIONS inside one document (a decision called `x` and a feedback called `x`).
  const touched = []
  if (claimKind === 'closure-link' || claimKind === 'one-sided-closure') touched.push(String(claim.locator.feedbackId ?? ''), String(claim.locator.decisionId ?? ''))
  else if (claimKind === 'theme-membership' || claimKind === 'one-sided-theme') touched.push(String(claim.locator.feedbackId ?? ''), String(claim.locator.themeId ?? ''))
  else if (claimKind === 'unregistered-reference') touched.push(String(claim.locator.referencedId ?? ''))
  else if (claimKind === 'unclosed-feedback') touched.push(String(claim.locator.feedbackId ?? ''))
  else if (claimKind === 'orphan-decision') touched.push(String(claim.locator.decisionId ?? ''))
  else touched.push(String(claim.locator.feedbackId ?? ''))

  const scopes = documents.map((document) => ({ path: document.path, nodes: declaredIds(document) }))
  const collisions = touched
    .map((id) => ({ id, declarations: declarationsOf(scopes, id).map((scope) => scope.path) }))
    .filter((entry) => entry.id !== '' && entry.declarations.length > 1)
  const internal = []
  for (const document of documents) {
    const graph = analyse(document)
    for (const id of touched) {
      if (id === '') continue
      const roles = [graph.isFeedback(id), graph.isDecision(id), graph.isTheme(id)].filter(Boolean).length
      if (roles > 1) internal.push({ id, path: document.path })
    }
  }
  if (collisions.length > 0 || internal.length > 0) {
    const ambiguousIn = [
      ...collisions.flatMap((entry) => entry.declarations.map((path) => `${path}#${entry.id}`)),
      ...internal.map((entry) => `${entry.path}#${entry.id}(跨population重名)`),
    ]
    const parts = [
      ...collisions.map((entry) => `${entry.id} 同时被 ${entry.declarations.join(' 与 ')} 声明`),
      ...internal.map((entry) => `${entry.id} 在 ${entry.path} 里同时是反馈/决策/主题中的两种`),
    ]
    return refuse(claimKind, 'relocation-ambiguous',
      `ID 冲突：${parts.join('；')} —— 同一 ID 指向两个对象时，任何关于它的关系都无法确认，拒绝猜测`,
      { ambiguousIn: [...new Set(ambiguousIn)].sort(), scope: ID_AMBIGUOUS })
  }

  const named = documentByPath(documents, wantedPath)
  if (named !== null) {
    const graph = analyse(named)
    const outcome = against(graph, claim)
    if (outcome === null) {
      return refuse(claimKind, 'no-match',
        `声明的台账 ${named.path} 既不含这条声明所需的对象，也不与它矛盾 —— 声明没有指向这张台账`)
    }
    if (outcome.hit !== undefined) {
      return confirm(claimKind, graph, outcome.hit, outcome.tier, `在 ${named.path} 确认（${claimKind}）`)
    }
    return refuse(claimKind, outcome.tier, outcome.conflict, {
      ...(outcome.ambiguousIn === undefined ? {} : { ambiguousIn: outcome.ambiguousIn }),
      scope: outcome.ambiguousIn === undefined ? 'single-graph' : 'multi-route',
    })
  }

  // The named ledger is not in the corpus: relocate, but only onto a claim that
  // holds in EXACTLY ONE other ledger, and only when NO ledger contradicts it.
  const ledger = relocate()
  for (const document of documents) {
    const graph = analyse(document)
    if (document.path === named?.path) continue
    const outcome = against(graph, claim)
    if (outcome !== null && outcome.hit !== undefined) {
      ledger.record(claim, `${document.path}#${claimKind}`, { graph })
    } else if (outcome !== null && outcome.hit === undefined) {
      return refuse(claimKind, 'locator-mismatch',
        `声明的 "${wantedPath}" 不在语料中，而 "${document.path}" 明确与声明矛盾：${outcome.conflict}`)
    }
  }
  const verdict = ledger.verdict()
  if (verdict.kind === 'unique') {
    const graph = verdict.hit.graph
    const outcome = against(graph, claim)
    return confirm(claimKind, graph, outcome.hit, 'relocated-unique',
      `声明的 "${wantedPath}" 不在语料中；该声明在 "${graph.path}" 唯一成立，发现已搬迁`)
  }
  if (verdict.kind === 'ambiguous') {
    return refuse(claimKind, 'relocation-ambiguous',
      `声明的 "${wantedPath}" 不在语料中，且该声明在 ${verdict.ambiguousIn.length} 份台账里同样成立 —— 搬迁不唯一，拒绝猜测`,
      { ambiguousIn: verdict.ambiguousIn })
  }
  return refuse(claimKind, 'no-match', `声明的 "${wantedPath}" 不在语料中，也没有任何一份台账含这条声明`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '锚点是「反馈 ID + 决策 ID」或「反馈 ID + 逐字引文」。引擎在台账上重算：闭环是否两侧互证、决策是否真的没有相连项、引文是否逐字出现在记录里。单边声明、转述引文、ID 角色错位一律判未锚定。',
  verify,
})

/** Re-exported for the domain's tests and evidence tools. */
export { analyse as analyseLedger }
