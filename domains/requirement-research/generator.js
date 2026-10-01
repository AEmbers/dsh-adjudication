/**
 * requirement-research — the constrained extractor (the B family's FIRST stage).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `source.js`
 * ------------------------------------------------
 * In a B-family domain the pipeline is two-staged, and the stages are different
 * kinds of thing:
 *
 *   generate  ->  a DRAFT: candidate requirements, each of which must cite a
 *                 verbatim utterance. Model-produced, therefore unverified.
 *   review    ->  the audit-shaped loop (P4/P6) that this domain shares with the
 *                 A family, run over the gated utterance candidates.
 *
 * `source.js` enumerates the MATERIAL (the quotes). This file turns drafts into
 * anchored items: every item it emits carries the verdict of the domain's own
 * `anchor.js`, so an item exists only if the corpus really says it. That is what
 * "受约束的抽取器" means mechanically — the constraint is the anchor, not a
 * polite instruction in a prompt.
 *
 * THE RULE ABOUT UNSUPPORTED DRAFTS
 * ---------------------------------
 * A draft that cannot be hung on an utterance is NOT deleted. It is returned in
 * `unsourced`, with the failed anchor verdict attached, because "we could not
 * source this" is itself a finding — and in a recall-first domain, silently
 * dropping it is exactly the error the orientation exists to prevent.
 */

import { ERROR_CODES, contractError } from '../../lib/contracts.js'
import { verify } from './anchor.js'

export const GENERATOR_KIND = 'requirement-extraction'

/** Anchor kind the extractor hangs its items on. Kept in sync with `anchor.js`. */
export const ANCHOR_KIND = 'verbatim-and-timestamp'

const slug = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/\s+/gu, '-')
  .replace(/[^a-z0-9._-]+/gu, '-')
  .replace(/^-+|-+$/gu, '')

/**
 * Build the corpus document set the anchor verifier re-checks against.
 *
 * ONE RAW UTTERANCE PER LINE, including empty ones, so a line number IS the
 * utterance index the source reports. Building the documents from the ENUMERATED
 * candidates instead would silently renumber the corpus whenever a blank turn
 * was skipped, and then every declared turn number would be off by one.
 */
export function corpusDocuments(input) {
  if (input === null || typeof input !== 'object' || !Array.isArray(input.sessions)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'interview-corpus 输入必须是对象 { sessions: [...] }')
  }
  const documents = []
  for (const session of input.sessions) {
    if (session === null || typeof session !== 'object') continue
    const sessionId = slug(session.id)
    if (sessionId === '') continue
    const utterances = Array.isArray(session.utterances) ? session.utterances : []
    if (utterances.length === 0) continue
    documents.push({
      path: `sessions/${sessionId}`,
      content: utterances.map((utterance) => (typeof utterance?.text === 'string' ? utterance.text : '')).join('\n'),
      times: utterances.map((utterance) => (typeof utterance?.t === 'string' ? utterance.t : '')),
    })
  }
  return documents
}

/**
 * Turn draft requirements into anchored ones.
 *
 * @param {{sessions: object[]}} input the documented corpus
 * @param {{claims?: object[]}} [context] `claims[i] = { id, statement, sessionId, turn, t?, quote, claimedGrade? }`
 * @returns {{kind:string, items:object[], unsourced:object[], notes:string[], bounded:boolean}}
 */
export function generate(input, context = {}) {
  const claims = Array.isArray(context.claims) ? context.claims : []
  const documents = corpusDocuments(input)
  const items = []
  const unsourced = []
  const notes = []

  if (documents.length === 0) {
    notes.push('语料里没有任何可用场次 —— 抽取器无从下锚，items 为空是合法结论。')
  }
  if (claims.length === 0) {
    notes.push('没有提供 claims 草案：抽取器不凭空生成需求，items 为空。')
  }

  for (const [index, claim] of claims.entries()) {
    const id = String(claim?.id ?? `draft-${index + 1}`)
    const statement = String(claim?.statement ?? '')
    const sessionId = slug(claim?.sessionId ?? '')
    const anchorClaim = {
      kind: ANCHOR_KIND,
      path: sessionId === '' ? '' : `sessions/${sessionId}`,
      locator: {
        sessionId,
        utteranceIndex: Number.isInteger(claim?.turn) ? claim.turn : undefined,
        t: typeof claim?.t === 'string' ? claim.t : undefined,
      },
      excerpt: String(claim?.quote ?? ''),
    }

    if (anchorClaim.path === '') {
      unsourced.push({
        id, statement, reason: 'source-missing',
        detail: '草案没有声明来源场次 —— 无来源条目单独列出，不丢弃',
        attemptedAnchor: anchorClaim,
      })
      continue
    }

    let verdict
    try {
      verdict = verify(anchorClaim, { documents })
    } catch (error) {
      unsourced.push({ id, statement, reason: 'anchor-contract', detail: error?.message ?? String(error), attemptedAnchor: anchorClaim })
      continue
    }

    if (verdict.status === 'anchored') {
      items.push({
        id,
        statement,
        // The engine's verdict travels WITH the item: a downstream reviewer never
        // has to trust the draft's own claim about where its quote came from.
        // The claim travels too, so the item can be re-verified byte for byte.
        claim: anchorClaim,
        anchor: verdict,
        sourceAnchor: `${verdict.path}:${verdict.start}`,
        claimedGrade: String(claim?.claimedGrade ?? '(未声明)'),
        evidenceGrade: 'verbatim-anchored',
        inferred: String(claim?.claimedGrade ?? '') === 'inferred',
      })
    } else {
      // Not dropped — reported. In a recall-first domain this list is part of
      // the deliverable, not a log line.
      unsourced.push({
        id,
        statement,
        reason: verdict.tier,
        detail: verdict.detail,
        ambiguousIn: verdict.ambiguousIn,
        attemptedAnchor: anchorClaim,
      })
    }
  }

  if (unsourced.length > 0) {
    notes.push(`${unsourced.length} 条草案挂不上原话，已单独列为「无来源」—— 未丢弃，需人工确认或补证据。`)
  }

  return {
    kind: GENERATOR_KIND,
    anchorKind: ANCHOR_KIND,
    items,
    unsourced,
    notes,
    // The generator itself is a total function of (corpus, drafts); the CLAIMS
    // are model-produced, which is why every item is still re-checked by P6.
    bounded: true,
  }
}

export default { kind: GENERATOR_KIND, anchorKind: ANCHOR_KIND, generate, corpusDocuments }
