/**
 * requirement-research — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `interview-corpus`
 * ------------------------------------------
 *   {
 *     sessions: [{
 *       id,                                   // 访谈场次 id，会成为候选 path 的一段
 *       participant: { id, role },            // 受访者；role 用于样本偏差检查
 *       startedAt,                            // ISO 时间戳（场次级）
 *       utterances: [{
 *         t,                                  // 该轮的时间戳（句级）
 *         speaker,                            // 'interviewer' | 'participant' | 任意
 *         text,                               // 逐字原文 —— 候选就是它本身
 *         redacted?,                          // 已脱敏：不可作为文本审核
 *         withdrawn?,                         // 撤回授权：不得进入判定
 *       }],
 *     }],
 *     notes?: [],
 *   }
 *
 * ONE CANDIDATE PER UTTERANCE — and the candidate IS the quote, never the derived
 * requirement. That distinction is the domain: a requirement is a product of the
 * extractor (see `generator.js`), and a candidate that had already been
 * interpreted would make the anchor unverifiable.
 *
 * WHY `path` IS SYNTHETIC
 * -----------------------
 * `session-1/u3` is not a file. It is the identity the P1 gate globs, so it is
 * built from the session id and the turn number and nothing else: the
 * the retracted-corpus exclusion and the `binary`/`deleted` predicates then mean
 * something without the source having to pre-decide reviewability. The source
 * only *enumerates*; the gate decides.
 *
 * HONESTY: `bounded:true` is true only because the corpus is handed in whole.
 * The domain is recall-first, so nothing here drops a turn it cannot classify —
 * a skipped turn becomes an `excluded` entry with a reason.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

/** Path-safe slug for a session id. Never used as anything but an identity. */
const UNSAFE = /[^a-z0-9._-]+/gu
const slug = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/\s+/gu, '-')
  .replace(UNSAFE, '-')
  .replace(/^-+|-+$/gu, '')

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/**
 * The documented-input -> candidate-set function.
 *
 * @param {{sessions: object[], notes?: string[]}} input
 * @param {{maxCandidates?: number, maxExcerptLines?: number}} [context]
 * @returns {{candidates: object[], excluded: object[], notes: string[], bounded: boolean, truncated: boolean}}
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'interview-corpus 输入必须是对象 { sessions: [...] }')
  }
  if (!Array.isArray(input.sessions)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'interview-corpus 输入缺少数组字段 `sessions`（每场访谈一项）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const candidates = []
  const excluded = []
  const notes = Array.isArray(input.notes) ? input.notes.map((note) => String(note)) : []
  let truncated = false

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过（场次 id 需要唯一）`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  for (const [sessionIndex, session] of input.sessions.entries()) {
    if (session === null || typeof session !== 'object') {
      excluded.push({ id: `session#${sessionIndex + 1}`, reason: 'session 不是对象' })
      continue
    }
    const sessionId = slug(session.id)
    if (sessionId === '') {
      excluded.push({ id: `session#${sessionIndex + 1}`, reason: 'session 缺少可用的 id' })
      continue
    }
    const utterances = Array.isArray(session.utterances) ? session.utterances : []
    if (utterances.length === 0) {
      // A session with no turns is not an empty result — it is a session that
      // produced nothing citable, and saying so is different from saying nothing.
      excluded.push({ id: `sessions/${sessionId}`, reason: 'session 没有任何 utterance —— 没有可引用的原话' })
      continue
    }

    const participant = session.participant ?? {}
    const participantId = String(participant.id ?? '(未提供)')
    const role = String(participant.role ?? '(未提供)')

    for (const [turnIndex, utterance] of utterances.entries()) {
      const turn = turnIndex + 1
      const raw = typeof utterance?.text === 'string' ? utterance.text : ''
      if (raw.trim() === '') {
        excluded.push({ id: `sessions/${sessionId}/u${turn}`, reason: 'utterance 没有可用文本' })
        continue
      }
      const lines = raw.split(/\r?\n/u)
      const overLimit = lines.length > maxExcerptLines
      const text = overLimit ? lines.slice(0, maxExcerptLines).join('\n') : raw
      if (overLimit) {
        truncated = true
        notes.push(`sessions/${sessionId}/u${turn} 超过 maxExcerptLines ${maxExcerptLines}，已截断`)
      }
      push({
        id: `${sessionId}#u${turn}`,
        // The gate globs this; it is an identity, not a path on disk.
        path: `sessions/${sessionId}/u${turn}`,
        locator: {
          sessionId,
          sessionIndex,
          utteranceIndex: turn,
          t: utterance?.t ?? null,
          participantId,
        },
        text,
        bytes: byteLength(text),
        // Consent and redaction are facts about the MATERIAL, and the gate has
        // a predicate for each. The source states them; it does not act on them.
        binary: utterance?.redacted === true,
        deleted: utterance?.withdrawn === true,
        meta: {
          kind: 'utterance',
          sessionId,
          sessionIndex,
          turn,
          t: utterance?.t ?? null,
          speaker: String(utterance?.speaker ?? '(未标注)'),
          participantId,
          role,
          redacted: utterance?.redacted === true,
          withdrawn: utterance?.withdrawn === true,
          clipped: overLimit,
        },
      })
    }
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'verbatim-quotes',
  inputFormat: 'interview-corpus',
  bounded: true,
  describe: '访谈语料 -> 每一句用户原话一个候选；脱敏句交给 binary 谓词、撤回授权句交给 deleted 谓词，由 P1 闸门判定。',
  enumerate,
})
