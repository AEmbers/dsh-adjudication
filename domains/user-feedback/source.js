/**
 * user-feedback — P0 candidate source (contract v2, extension point 1).
 *
 * THE DOCUMENTED INPUT FORMAT: `feedback-ledger`
 * ---------------------------------------------
 * A ledger is two ledgers that must agree with each other:
 *
 *   {
 *     "ledgerPath": "feedback/ledger.json",          // optional; the document path
 *     "feedback": [
 *       { "id": "fb-1001", "quote": "<原话>", "source": "应用商店",
 *         "severity": "high", "reach": "many", "frequency": 3,
 *         "theme": "checkout", "status": "closed", "closedBy": "dec-20",
 *         "closeReason": "已在 2.4 修掉", "body": "..." }
 *     ],
 *     "decisions": [
 *       { "id": "dec-20", "title": "结算页重做", "rationale": "...",
 *         "addresses": ["fb-1001"], "status": "shipped", "owner": "alice" }
 *     ],
 *     "themes": [
 *       { "id": "checkout", "name": "结算流程", "members": ["fb-1001"] }
 *     ]
 *   }
 *
 * `documents: [{path, type, meta, payload}]` may be used instead, exactly as in
 * the other D-family domains, when the ledger is split across several files.
 *
 * WHY THE CANDIDATE UNIT IS A LINK
 * -------------------------------
 * `lib/contracts.js` §5 declares this domain's candidates as "one per
 * feedback-to-decision link". That is the whole point of the domain: a feedback
 * item on its own can be perfectly written and still be lost, and a decision on its
 * own can be perfectly reasoned and still address nothing. The defect lives in the
 * RELATION, so the relation is the unit of adjudication.
 *
 * The two spellings of that relation are BOTH read, and that is not a convenience:
 *
 *   decisions[i].addresses[]  — "this decision claims to handle those items"
 *   feedback[i].closedBy      — "this item was closed by that decision"
 *
 * A closure is real only when those agree. Either one alone is a one-sided claim,
 * and one-sided claims are this domain's most common real defect — a team marks the
 * ticket closed while the decision record never mentions it, or a decision claims to
 * address feedback whose entry still reads `open`. Reading only one side would make
 * half of those invisible, and reading the UNION without checking the sides would
 * make them all invisible at once.
 *
 * THE CANDIDATE PATH SCHEME, AND WHAT IT COSTS
 * -------------------------------------------
 * A feedback-to-decision link is not a file, so a candidate's `path` is a DOCUMENT
 * REFERENCE derived from the ledger document, spelled with a real extension:
 *
 *   path = 'feedback/ledger-fb-1001-dec-20.json'    (the link fb-1001 <-> dec-20)
 *   id   = the same string
 *
 * The `#`-fragment form used by an earlier draft is impossible here, for three
 * separate reasons in `lib/`: `validateCandidateSetResult` rejects `>` and upper
 * case in a candidate path (`ID_PATTERN`); `gate()` reports an exclusion as
 * `{path, predicate}` only, so two candidates sharing a path cannot be told apart in
 * `plan.gate.excluded`; and the extension predicate reads
 * `path.slice(path.lastIndexOf('.'))`, so a fragment containing a dot is taken for
 * the extension and the candidate is dropped as "unsupported file type". Encoding
 * the link into the path keeps each candidate a distinct, gate-globable identity.
 *
 * The cost is stated rather than discovered later: `coverage()` counts DISTINCT
 * PATHS, so this domain's coverage denominator is the admitted CANDIDATE count (one
 * per link, plus one per node), not the number of ledger documents. That is the
 * right denominator — the reviewer's unit of judgement is one link or one record,
 * and "6 of 14 links adjudicated" is the honest progress claim.
 *
 * THE SEVERITY/FREQUENCY SPLIT, AND WHY IT LIVES HERE
 * --------------------------------------------------
 * `ledgerRanks()` below produces TWO independent orderings of the same ledger —
 * one by LOSS (severity x reach) and one by FREQUENCY (how often the item was
 * reported) — plus `drownRisk`, the items that a frequency-sorted triage would
 * bury. This is a deliberate, tested property of the domain rather than a style
 * note in a prompt: the classic failure of a feedback pipeline is that a
 * once-reported, data-losing checkout bug loses to a forty-times-reported
 * "the icon looks slightly off", because the only number on the dashboard is a
 * count. Keeping the two rankings in the source means the anchor, the evidence
 * tools and the prompts all read the same separation.
 */

import {
  ERROR_CODES,
  contractError,
  defineCandidateSource,
} from '../../lib/contracts.js'
import {
  byteLength,
  clipLines,
  derivedPath,
  documentsOf,
  looksLikeGraph,
  slash,
} from '../_lib/graph.js'

/** The two ways a ledger can spell the same link. */
export const EDGE_KINDS = Object.freeze(['addresses', 'closed-by'])

/** Candidate families this source emits. */
export const CANDIDATE_KINDS = Object.freeze({
  link: 'closure-edge',
  feedback: 'feedback-node',
  decision: 'decision-node',
  theme: 'theme-node',
})

/** Feedback states that mean "out of scope for this pass". */
const ARCHIVED = new Set(['archived', 'removed', 'cancelled', 'duplicate', 'spam'])

/**
 * Severity -> loss weight. Deliberately coarse: this is a RANK KEY, not a
 * precision instrument, and a finer scale would invite the reader to believe the
 * product of two guesses is a measurement.
 */
export const SEVERITY_WEIGHT = Object.freeze({
  blocker: 8,
  critical: 8,
  high: 4,
  medium: 2,
  normal: 2,
  low: 1,
  minor: 1,
})

/** Reach (how many users are affected) -> weight, same coarse scale. */
export const REACH_WEIGHT = Object.freeze({
  all: 8,
  everyone: 8,
  many: 4,
  some: 2,
  few: 1,
  one: 1,
})

/** A quote shorter than this cannot identify a record, so it is not a claim. */
export const MIN_QUOTE_CHARS = 8

const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `feedback/ledger.json` + ('dec-20','fb-1001') -> `feedback/ledger-fb-1001-dec-20.json` */
export function closureEdgePath(documentPath, decisionId, feedbackId) {
  return derivedPath(documentPath, `${feedbackId}-${decisionId}`)
}

/**
 * The node path family, prefixed by POPULATION.
 *
 * The prefix is not decoration. Feedback ids and decision ids are two independent
 * namespaces, and the same string in both is a real defect this domain must be able
 * to REPORT (`duplicate-id-across-populations`). Deriving a node path from the bare
 * id would give the two colliding records the same `path` AND the same candidate
 * `id`, which `validateCandidateSetResult` rejects outright — the defect would crash
 * the run instead of being reported. The prefix keeps every candidate a distinct
 * identity while the raw ids stay in `locator` and in `text`.
 *
 * A redundant prefix on the id itself (`fb-1001` -> `fb-fb-1001`) is stripped so the
 * path stays readable; the strip is cosmetic and nothing parses an id back out of a
 * path.
 */
function populationPrefixed(prefix, id) {
  const text = String(id ?? '')
  const lowered = text.toLowerCase()
  const bare = lowered.startsWith(`${prefix}-`) ? text.slice(prefix.length + 1) : text
  return `${prefix}-${bare}`
}

export function feedbackPath(documentPath, feedbackId) {
  return derivedPath(documentPath, populationPrefixed('fb', feedbackId))
}

export function decisionPath(documentPath, decisionId) {
  return derivedPath(documentPath, populationPrefixed('dec', decisionId))
}

export function themePath(documentPath, themeId) {
  return derivedPath(documentPath, `theme-${themeId}`)
}

/**
 * The theme a record belongs to, or `null`.
 *
 * Two spellings again, and the same reasoning: `feedback.theme` is the tag on the
 * item, `themes[i].members` is the list on the theme. The one that matters for
 * grouping is whichever exists, with the item's own tag preferred because it is
 * per-record and survives a theme catalogue that was not updated.
 */
export function themeOf(feedback) {
  return isNonEmpty(feedback?.theme) ? String(feedback.theme) : null
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/** Normalise the documented input into graph documents. */
export function corpus(input) {
  const problems = []
  const documents = []

  if (Array.isArray(input?.documents) && input.documents.length > 0) {
    for (const document of documentsOf(input.documents)) {
      if (!looksLikeGraph(document.payload)) {
        problems.push(`${document.path}: 文档 payload 既没有 feedback 也没有 decisions/themes，无法当作反馈台账读取`)
        continue
      }
      documents.push(document)
    }
    if (documents.length === 0) problems.push('documents[] 里没有可读的反馈台账文档')
    return { documents, problems }
  }

  const ledgerPath = isNonEmpty(input?.ledgerPath) ? slash(input.ledgerPath) : 'feedback/ledger.json'
  documents.push({
    path: ledgerPath,
    type: 'feedback-ledger',
    payload: {
      feedback: Array.isArray(input?.feedback) ? input.feedback : [],
      decisions: Array.isArray(input?.decisions) ? input.decisions : [],
      themes: Array.isArray(input?.themes) ? input.themes : [],
    },
    meta: input?.meta !== null && typeof input?.meta === 'object' ? input.meta : {},
  })
  return { documents, problems }
}

/** `[{id,...}]` -> `Map`, first declaration wins. */
export function byId(list) {
  const out = new Map()
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object' || !isNonEmpty(item.id)) continue
    if (!out.has(item.id)) out.set(item.id, item)
  }
  return out
}

/** Every id a ledger document declares — both populations and the theme catalogue. */
export function declaredIds(document) {
  const payload = document?.payload ?? {}
  return [
    ...(Array.isArray(payload.feedback) ? payload.feedback.map((item) => item?.id) : []),
    ...(Array.isArray(payload.decisions) ? payload.decisions.map((item) => item?.id) : []),
    ...(Array.isArray(payload.themes) ? payload.themes.map((item) => item.id) : []),
  ].filter(isNonEmpty)
}

/** The two populations, kept apart: an id collision ACROSS them is a defect. */
export function populations(document) {
  const payload = document?.payload ?? {}
  const feedback = Array.isArray(payload.feedback) ? payload.feedback : []
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : []
  return {
    feedback,
    decisions,
    themes: Array.isArray(payload.themes) ? payload.themes : [],
    feedbackById: byId(feedback),
    decisionById: byId(decisions),
    themeById: byId(Array.isArray(payload.themes) ? payload.themes : []),
  }
}

/**
 * Every link a ledger declares, deduplicated to an undirected `[decisionId,
 * feedbackId]` pair, in declaration order — the TOPOLOGY.
 *
 * Deduplicated on purpose: `addresses` and `closedBy` are two ways of saying "there
 * is a link here", and a pair declared by both spellings is still ONE edge of the
 * graph. Whether the two spellings AGREE is a separate question — that is a
 * property of the evidence, checked by `linkSides()` and by the anchor verifier —
 * and collapsing the two notions into one would make a one-sided closure
 * indistinguishable from a real one.
 */
export function linkPairs(document) {
  const { feedback, decisions } = populations(document)
  const seen = new Set()
  const pairs = []
  const push = (decisionId, feedbackId) => {
    const key = `${decisionId}\u0000${feedbackId}`
    if (seen.has(key)) return
    seen.add(key)
    pairs.push([String(decisionId), String(feedbackId)])
  }
  for (const decision of decisions) {
    if (!isNonEmpty(decision?.id)) continue
    for (const target of Array.isArray(decision.addresses) ? decision.addresses : []) {
      if (isNonEmpty(target)) push(decision.id, target)
    }
  }
  for (const item of feedback) {
    if (!isNonEmpty(item?.id) || !isNonEmpty(item.closedBy)) continue
    push(item.closedBy, item.id)
  }
  return pairs
}

/**
 * Which spellings of each link the ledger actually contains.
 *
 * `key` is `"<decisionId>\u0000<feedbackId>"`. A pair with only one spelling is a
 * ONE-SIDED closure — the defect class this domain exists to find, and the reason
 * `linkPairs()` must not carry this information itself.
 */
export function linkSides(document) {
  const { feedback, decisions } = populations(document)
  const sides = new Map()
  const touch = (decisionId, feedbackId) => {
    const key = `${decisionId}\u0000${feedbackId}`
    if (!sides.has(key)) sides.set(key, { decisionId: String(decisionId), feedbackId: String(feedbackId), addresses: false, closedBy: false })
    return sides.get(key)
  }
  for (const decision of decisions) {
    if (!isNonEmpty(decision?.id)) continue
    for (const target of Array.isArray(decision.addresses) ? decision.addresses : []) {
      if (isNonEmpty(target)) touch(decision.id, target).addresses = true
    }
  }
  for (const item of feedback) {
    if (!isNonEmpty(item?.id) || !isNonEmpty(item.closedBy)) continue
    touch(item.closedBy, item.id).closedBy = true
  }
  return sides
}

/** `"<decisionId>\u0000<feedbackId>"` — the key both `linkSides` and the verifier use. */
export function linkKey(decisionId, feedbackId) {
  return `${String(decisionId)}\u0000${String(feedbackId)}`
}

/** The side record for one link, or `null` when the ledger declares no link at all. */
export function sidesOf(document, decisionId, feedbackId) {
  return linkSides(document).get(linkKey(decisionId, feedbackId)) ?? null
}

/** Does this document declare `id`, in any population? */
export function declares(document, id) {
  return declaredIds(document).includes(String(id ?? ''))
}

// ---------------------------------------------------------------------------
// The two rankings that must not be merged
// ---------------------------------------------------------------------------

const weightOf = (map, value, fallback = 1) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  const key = String(value ?? '').toLowerCase().trim()
  return map[key] ?? fallback
}

/**
 * Loss and frequency, ranked SEPARATELY.
 *
 * The returned object is the domain's answer to "which feedback should we look at
 * first", and it deliberately refuses to answer with a single list:
 *
 *   byLoss      — severity x reach, descending. "How bad is this when it happens."
 *   byFrequency — how many times it was reported, descending. "How often we hear it."
 *   drownRisk   — items in the top LOSS quartile that sit in the bottom half by
 *                 FREQUENCY. Those are precisely the items a count-sorted triage
 *                 buries, and the reason this function exists.
 *
 * `drownRisk` is empty for a ledger with fewer than four rows, and that is honest
 * rather than convenient: quartiles of three items are noise, and reporting a
 * "highest-loss quartile" of one item would be a number pretending to be a
 * measurement.
 *
 * Ties are broken by id so the orderings are TOTAL and stable — a ranking that
 * depends on input order would make the assertions about it meaningless.
 */
export function ledgerRanks(document) {
  const { feedback } = populations(document)
  const rows = feedback
    .filter((item) => isNonEmpty(item?.id))
    .map((item) => {
      const severityWeight = weightOf(SEVERITY_WEIGHT, item.severity)
      const reachWeight = weightOf(REACH_WEIGHT, item.reach)
      const frequency = Number.isFinite(Number(item.frequency)) ? Number(item.frequency) : 0
      return {
        id: String(item.id),
        severity: isNonEmpty(item.severity) ? String(item.severity) : 'unspecified',
        severityWeight,
        reach: isNonEmpty(item.reach) ? String(item.reach) : 'unspecified',
        reachWeight,
        frequency,
        loss: severityWeight * reachWeight,
      }
    })

  const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const byLoss = [...rows].sort((a, b) => (b.loss - a.loss) || byIdAsc(a, b)).map((row) => row.id)
  const byFrequency = [...rows].sort((a, b) => (b.frequency - a.frequency) || byIdAsc(a, b)).map((row) => row.id)

  let drownRisk = []
  if (rows.length >= 4) {
    const lossCut = Math.ceil(rows.length / 4)
    const frequencyFloor = Math.floor(rows.length / 2)
    const lossTop = new Set(byLoss.slice(0, lossCut))
    drownRisk = byLoss
      .filter((id) => lossTop.has(id) && byFrequency.indexOf(id) >= frequencyFloor)
      // Ordered by LOSS, so the reader meets the most expensive drowned item first.
      .sort((a, b) => byLoss.indexOf(a) - byLoss.indexOf(b))
  }

  return { rows, byLoss, byFrequency, drownRisk }
}

/**
 * Every closure question the ledger leaves open, one entry per item.
 *
 * This is the recall-first domain's work list, and it is returned as a LIST rather
 * than a count for the reason the acceptance criteria name: "closed 8 of 14" tells
 * a reader nothing about WHICH six are missing, and the missing six are the entire
 * deliverable. Each entry names the item, which side (if any) exists, and what the
 * ledger would have to say to close it.
 *
 * `orphanDecisions` is the mirror image: decisions that address nothing and are
 * named by no closure. Both are returned so a caller cannot report one and forget
 * the other.
 *
 * Three gap kinds, and the third is the one that used to be missing entirely:
 *   - `unclosed-feedback`  — declared feedback with no link in either direction.
 *   - `one-sided-closure`  — a link declared by ONE spelling (`addresses` xor
 *                            `closedBy`), against records that both exist.
 *   - `dangling-closure`   — `closedBy` names a decision that was never recorded.
 *   - `dangling-address`   — `addresses` names a feedback that was never recorded.
 *                            The mirror of the above, and until F3 it was reported
 *                            by NO branch of this function.
 * A dangling link is a different defect from a missing one: a missing link means
 * nobody acted, a dangling link means the record of who acted points nowhere, so
 * the item is neither open nor closed and no count of unclosed feedback contains
 * it.
 */
export function closureGaps(document) {
  const { feedback, decisions } = populations(document)
  const sides = linkSides(document)

  const byFeedback = new Map()
  for (const side of sides.values()) {
    if (!byFeedback.has(side.feedbackId)) byFeedback.set(side.feedbackId, [])
    byFeedback.get(side.feedbackId).push(side)
  }
  const byDecision = new Map()
  for (const side of sides.values()) {
    if (!byDecision.has(side.decisionId)) byDecision.set(side.decisionId, [])
    byDecision.get(side.decisionId).push(side)
  }

  const gaps = []
  for (const item of feedback) {
    if (!isNonEmpty(item?.id)) continue
    const id = String(item.id)
    const links = byFeedback.get(id) ?? []
    const mutual = links.filter((side) => side.addresses && side.closedBy)
    if (mutual.length > 0) continue
    if (links.length === 0) {
      gaps.push({ kind: 'unclosed-feedback', feedbackId: id, decisionId: null, side: 'none',
        reason: `反馈 ${id} 既没有 closedBy，也没有任何决策在 addresses 里提到它 —— 闭环缺失` })
      continue
    }
    // A link whose decision is not in `decisions` is a DIFFERENT defect from a link that
    // is merely one-sided: nothing can be one-sided against a record that does not
    // exist. Keeping them apart matters for the anchor: a one-sided closure is verified
    // against the decision it names, while a dangling one is verified as an
    // unregistered reference — two different claims with two different verdicts.
    const declarations = new Set(decisions.map((decision) => decision?.id).filter(isNonEmpty).map(String))
    const dangling = links.filter((side) => !declarations.has(side.decisionId))
    if (dangling.length === links.length) {
      gaps.push({
        kind: 'dangling-closure',
        feedbackId: id,
        decisionId: dangling[0].decisionId,
        side: 'closed-by-only',
        reason: `反馈 ${id} 的 closedBy 指向 ${dangling.map((side) => side.decisionId).join('、')}，而该 ID 在 decisions 里根本不存在 —— 这是悬空闭环（失效链接），不是单边闭环`,
      })
      continue
    }
    const onlyAddresses = links.every((side) => side.addresses && !side.closedBy)
    const onlyClosedBy = links.every((side) => !side.addresses && side.closedBy)
    gaps.push({
      kind: 'one-sided-closure',
      feedbackId: id,
      decisionId: links[0].decisionId,
      side: onlyAddresses ? 'addresses-only' : onlyClosedBy ? 'closed-by-only' : 'mixed',
      reason: onlyAddresses
        ? `决策 ${links.map((side) => side.decisionId).join('、')} 声明处理了反馈 ${id}，但 ${id} 的 closedBy 不是它们（或未登记）—— 闭环只有单边声明`
        : onlyClosedBy
          ? `反馈 ${id} 的 closedBy 指向 ${links.map((side) => side.decisionId).join('、')}，但对方从未在 addresses 里声明处理过它 —— 闭环只有单边声明`
          : `反馈 ${id} 与 ${links.length} 个决策之间的关系互相矛盾（有的单边、有的另一边）`,
    })
  }

  const orphanDecisions = []
  for (const decision of decisions) {
    if (!isNonEmpty(decision?.id)) continue
    const id = String(decision.id)
    if ((byDecision.get(id) ?? []).length > 0) continue
    orphanDecisions.push({ decisionId: id, reason: `决策 ${id} 既没有 addresses 任何反馈，也没有任何反馈的 closedBy 指向它 —— 它与反馈台账无关` })
  }

  // F3 — the MIRROR of `dangling-closure`, and the direction that used to be
  // invisible.
  //
  // `dangling-closure` catches a feedback's `closedBy` naming a decision that was
  // never recorded. The reverse — a DECISION whose `addresses` names a feedback id
  // that appears nowhere in `feedback[]` — fell through every branch above: the
  // gap loop iterates the DECLARED feedback rows, so an undeclared id can never be
  // its subject, and `orphanDecisions` skips the decision because it does have a
  // link. A ledger could therefore claim "decision D closed feedback fb-9999"
  // where fb-9999 does not exist, and the gap analysis reported nothing at all.
  //
  // That omission is the worst kind for this domain. This pack is recall-first:
  // its entire product is the list of things that did not close. A broken link is
  // not a smaller problem than a missing link, it is a DIFFERENT one — a missing
  // link means nobody acted, a broken link means the record of who acted points
  // nowhere, so the item is neither open nor closed and no count of "unclosed
  // feedback" can contain it.
  //
  // Kept as its own kind rather than folded into `dangling-closure` because the
  // two are verified by different claims: `dangling-closure` is anchored by
  // naming the decision that does not exist, this one by naming the feedback that
  // does not exist. Both are `unregistered-reference` at the anchor layer, but a
  // report that merged them would tell the reader they had fixed one direction
  // when they had fixed the other.
  //
  // `feedbackId` keeps its meaning across all gap kinds (the feedback id the gap
  // is about) even though that id is undeclared here — the whole point of the
  // finding is that the ledger names it. `decisionId` is the real, declared
  // decision that points at nothing.
  const declaredFeedback = new Set(feedback.map((item) => item?.id).filter(isNonEmpty).map(String))
  for (const decision of decisions) {
    if (!isNonEmpty(decision?.id)) continue
    const decisionId = String(decision.id)
    const targets = (Array.isArray(decision.addresses) ? decision.addresses : []).filter(isNonEmpty).map(String)
    const dangling = targets.filter((target) => !declaredFeedback.has(target))
    if (dangling.length === 0) continue
    for (const target of dangling) {
      gaps.push({
        kind: 'dangling-address',
        feedbackId: target,
        decisionId,
        side: 'addresses-only',
        reason: `决策 ${decisionId} 在 addresses 里声明处理了反馈 ${target}，而 ${target} 在 feedback 里根本不存在 —— 这是悬空引用（失效链接），既不是闭环，也不是未闭环`,
      })
    }
  }

  const keyOf = (entry) => entry.feedbackId ?? entry.decisionId
  const asc = (a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0)
  gaps.sort(asc)
  orphanDecisions.sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0))
  return { gaps, orphanDecisions }
}

/** The verbatim-quote normaliser shared by the source, the verifier and the tools. */
export function normalizeQuote(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim()
}

/** Every feedback row whose recorded quote verbatim contains `text`. */
export function quoteMatches(document, text) {
  const wanted = normalizeQuote(text)
  if (wanted.length < MIN_QUOTE_CHARS) return []
  const { feedback } = populations(document)
  const out = []
  for (const item of feedback) {
    if (!isNonEmpty(item?.id)) continue
    if (normalizeQuote(item.quote).includes(wanted)) out.push(String(item.id))
  }
  return out
}

// ---------------------------------------------------------------------------
// enumerate()
// ---------------------------------------------------------------------------

/**
 * The documented-input -> candidate-set function.
 *
 * `context` is what the engine hands every source. The source does NOT apply the
 * gate — it only reports what it saw, so "P0 enumerated nothing" and "P1 removed
 * everything" stay distinguishable in the plan.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'feedback-ledger 输入必须是对象 { feedback: [...], decisions: [...] }')
  }
  for (const key of ['feedback', 'decisions', 'themes', 'documents']) {
    if (input[key] !== undefined && !Array.isArray(input[key])) {
      throw contractError(ERROR_CODES.E_INPUT_FORMAT, `\`${key}\` 必须是数组（可省略）`)
    }
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 200

  const { documents, problems } = corpus(input)
  const candidates = []
  const excluded = []
  const notes = [...problems]
  let truncated = false

  /**
   * The dedupe scope is ONE DOCUMENT, and the discriminator is split by FIELD
   * FAMILY for the same reason as in the sibling D domains: a link and a node hold
   * their identity in different key sets (`decisionId/feedbackId` versus
   * `feedbackId`), so a single `kind` field would collide by accident the day a
   * locator kind reuses a field. Inside a document the same record declared twice
   * is noise; ACROSS documents the same id is the `duplicate-id` defect itself, and
   * collapsing it would delete that finding.
   */
  const semanticKey = (candidate) => JSON.stringify({
    k: candidate.locator.decisionId !== undefined ? 'e' : 'n',
    d: candidate.locator.decisionId ?? null,
    f: candidate.locator.feedbackId ?? null,
    t: candidate.locator.themeId ?? null,
    r: candidate.locator.record ?? null,
  })

  let seenInDocument = new Map()
  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    const key = semanticKey(candidate)
    const existing = seenInDocument.get(key)
    if (existing !== undefined) {
      notes.push(`${candidate.path} 与 ${existing} 是同一文档内同一个台账元素，已跳过（同一 ID 出现在不同文档时不合并 —— 那是重复 ID 缺陷本身）`)
      return false
    }
    seenInDocument.set(key, candidate.path)
    candidates.push(candidate)
    return true
  }

  for (const document of documents) {
    seenInDocument = new Map()
    const path = document.path
    const meta = document.meta ?? {}
    const deleted = meta.deleted === true
    const binary = meta.binary === true
    const docBytes = Number(meta.bytes) > 0 ? Number(meta.bytes) : null
    const carried = { bytes: docBytes ?? undefined, binary: binary || undefined, deleted: deleted || undefined }

    const { feedback, decisions, themes, feedbackById, decisionById } = populations(document)
    const sides = linkSides(document)
    const known = new Set(declaredIds(document))

    // --- closure links -------------------------------------------------------
    for (const [decisionId, feedbackId] of linkPairs(document)) {
      const candidateId = closureEdgePath(path, decisionId, feedbackId)
      if (deleted) {
        excluded.push({ id: candidateId, reason: `链接 ${feedbackId} ↔ ${decisionId} 所在文档 ${path} 已标记 deleted` })
        continue
      }
      const side = sides.get(linkKey(decisionId, feedbackId))
      const item = feedbackById.get(feedbackId)
      const decision = decisionById.get(decisionId)
      const mutual = side?.addresses === true && side?.closedBy === true
      const text = [
        `closure ${feedbackId} ↔ ${decisionId}`,
        `反馈（${item?.severity ?? '未分级'}，被报 ${item?.frequency ?? 0} 次）：${item ? clipLines(normalizeQuote(item.quote), 4).text : '(该 ID 没有任何反馈记录)'}`,
        `决策：${decision?.title ?? '(该 ID 没有任何决策记录)'}`,
        `声明侧：${side?.addresses === true ? '决策 addresses 提到它' : '决策未提到它'}；${side?.closedBy === true ? '反馈 closedBy 指向它' : '反馈 closedBy 没指向它'}`,
        mutual ? '两侧一致 —— 这是一个成立的闭环' : '**只有单边声明 —— 闭环不成立**',
      ].join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'closure-edge', ledgerPath: path, decisionId, feedbackId },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.link,
          decisionId,
          feedbackId,
          mutual,
          oneSided: !mutual,
          theme: themeOf(item) ?? themeOf(decision),
          severity: isNonEmpty(item?.severity) ? String(item.severity) : 'unspecified',
          frequency: Number.isFinite(Number(item?.frequency)) ? Number(item.frequency) : 0,
          ledgerPath: path,
        },
      })
    }

    // --- feedback nodes ------------------------------------------------------
    for (const [index, item] of feedback.entries()) {
      if (item === null || typeof item !== 'object' || !isNonEmpty(item.id)) {
        excluded.push({ id: derivedPath(path, `feedback-${index + 1}`), reason: '反馈缺少非空字符串 id —— 无法在图上定位' })
        continue
      }
      const candidateId = feedbackPath(path, item.id)
      if (item.archived === true || ARCHIVED.has(String(item.status))) {
        excluded.push({ id: candidateId, reason: `反馈 ${item.id} 状态为 ${item.status ?? 'archived'}，不在本次评审范围` })
        continue
      }
      const links = [...sides.values()].filter((side) => side.feedbackId === String(item.id))
      const mutual = links.filter((side) => side.addresses && side.closedBy).length
      const text = [
        `feedback ${item.id}（${item.severity ?? '未分级'}，被报 ${item.frequency ?? 0} 次，来源 ${item.source ?? '未记录'}）`,
        `原话：${clipLines(normalizeQuote(item.quote), 6).text}`,
        `闭环：${mutual > 0 ? `已与 ${links.filter((side) => side.addresses && side.closedBy).map((side) => side.decisionId).join('、')} 互证` : links.length === 0 ? '**没有任何决策与它相连**' : `**只有 ${links.length} 条单边声明，未互证**`}`,
      ].join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'feedback-node', ledgerPath: path, feedbackId: String(item.id) },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.feedback,
          feedbackId: String(item.id),
          theme: themeOf(item),
          severity: isNonEmpty(item.severity) ? String(item.severity) : 'unspecified',
          frequency: Number.isFinite(Number(item.frequency)) ? Number(item.frequency) : 0,
          closureCount: mutual,
          ledgerPath: path,
        },
      })
    }

    // --- decision nodes ------------------------------------------------------
    for (const decision of decisions) {
      if (decision === null || typeof decision !== 'object' || !isNonEmpty(decision.id)) continue
      const candidateId = decisionPath(path, decision.id)
      if (decision.archived === true) {
        excluded.push({ id: candidateId, reason: `决策 ${decision.id} 已归档，不在本次评审范围` })
        continue
      }
      const links = [...sides.values()].filter((side) => side.decisionId === String(decision.id))
      const text = [
        `decision ${decision.id}（${decision.title ?? '(无标题)'}，状态 ${decision.status ?? '未记录'}）`,
        `声明处理：${(Array.isArray(decision.addresses) ? decision.addresses : []).join('、') || '**没有声明处理任何反馈**'}`,
        `实际互证的闭环：${links.filter((side) => side.addresses && side.closedBy).map((side) => side.feedbackId).join('、') || '无'}`,
      ].join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'decision-node', ledgerPath: path, decisionId: String(decision.id) },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.decision,
          decisionId: String(decision.id),
          declaredAddresses: (Array.isArray(decision.addresses) ? decision.addresses : []).length,
          mutualClosures: links.filter((side) => side.addresses && side.closedBy).length,
          ledgerPath: path,
        },
      })
    }

    // --- theme nodes ---------------------------------------------------------
    for (const theme of themes) {
      if (theme === null || typeof theme !== 'object' || !isNonEmpty(theme.id)) continue
      const candidateId = themePath(path, theme.id)
      const tagged = feedback.filter((item) => themeOf(item) === String(theme.id)).map((item) => String(item.id))
      const listed = Array.isArray(theme.members) ? theme.members.filter(isNonEmpty).map(String) : []
      const onlyTagged = tagged.filter((id) => !listed.includes(id))
      const onlyListed = listed.filter((id) => !tagged.includes(id))
      const text = [
        `theme ${theme.id}（${theme.name ?? '(未命名)'}）`,
        `按记录上的 theme 归入：${tagged.join('、') || '无'}`,
        `按主题的 members 列在册：${listed.join('、') || '无'}`,
        (onlyTagged.length === 0 && onlyListed.length === 0)
          ? '两侧一致'
          : `**两侧不一致**：只有 tag 的 ${onlyTagged.join('、') || '无'}；只有在册的 ${onlyListed.join('、') || '无'}`,
      ].join('\n')
      const clipped = clipLines(text, maxExcerptLines)
      if (clipped.truncated) { truncated = true; notes.push(`${candidateId} 超过 maxExcerptLines ${maxExcerptLines}，已截断`) }
      push({
        id: candidateId,
        path: candidateId,
        locator: { kind: 'theme-node', ledgerPath: path, themeId: String(theme.id) },
        text: clipped.text,
        bytes: byteLength(clipped.text),
        ...carried,
        additions: 1,
        meta: {
          candidateKind: CANDIDATE_KINDS.theme,
          themeId: String(theme.id),
          taggedCount: tagged.length,
          listedCount: listed.length,
          inconsistent: onlyTagged.length > 0 || onlyListed.length > 0,
          ledgerPath: path,
        },
      })
    }

    // A link that names an id nobody declares is not dropped: the reviewer must be
    // able to see that a decision addresses a feedback id that does not exist.
    for (const [decisionId, feedbackId] of linkPairs(document)) {
      for (const [missing, role] of [[feedbackId, '反馈'], [decisionId, '决策']]) {
        if (known.has(String(missing))) continue
        notes.push(`⚠️ ${role} ID "${missing}" 被链接引用，但本图的反馈/决策/主题里都没有它 —— 这是一条未登记的引用，交由评审判断`)
      }
    }
  }

  if (candidates.length === 0 && notes.length === 0) notes.push('这份台账里没有任何反馈、决策或主题 —— 空集本身就是一个结论')

  return {
    candidates,
    excluded: excluded.map((entry) => ({ id: String(entry.id), reason: String(entry.reason) })),
    notes,
    bounded: true,
    truncated,
  }
}

export default defineCandidateSource({
  kind: 'feedback-to-decision-links',
  inputFormat: 'feedback-ledger',
  bounded: true,
  describe: '反馈台账上每条「反馈 ↔ 决策」链接一个候选（两侧声明去重后），每条反馈、每个决策、每个主题各一个节点候选。单边声明不合并、未登记的引用不丢弃。',
  enumerate,
})
