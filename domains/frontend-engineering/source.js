/**
 * frontend-engineering — P0 candidate source (contract v2, extension point 1).
 *
 * REUSE, NOT REIMPLEMENTATION — same rule as backend-engineering
 * --------------------------------------------------------------
 * One candidate per (file, hunk), produced by code-review's parser
 * (`parseUnifiedDiff` / `hunkLineCounts` / `hunkNewSpan`), imported rather than
 * copied. What this module adds is the one thing a client-side reviewer needs
 * that a generic diff reviewer does not: the build's bundle report, joined in as
 * `candidate.meta.chunkBytes` so "this change costs 40KB of first paint" is a
 * fact attached to the candidate instead of a guess made at review time.
 *
 * DOCUMENTED INPUT FORMAT: `unified-diff` (identical to code-review)
 * -----------------------------------------------------------------
 *   {
 *     diff: string,
 *     files?: [{ path, bytes?, binary?, deleted?, additions?, deletions? }],
 *     bundleReport?: { '<chunk>': number } | { '<path>': number },
 *   }
 * `bundleReport` is keyed either by chunk name or by source path; when a
 * candidate's path is in it, that number becomes the candidate's cost.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'
import codeReviewSource, { hunkLineCounts, hunkNewSpan, parseUnifiedDiff } from '../code-review/source.js'

export { parseUnifiedDiff, hunkLineCounts, hunkNewSpan }

/**
 * The documented-input -> candidate-set function.
 * Delegates to the reference implementation, then attaches bundle cost.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'unified-diff 输入必须是对象 { diff, files?, bundleReport? }')
  }
  if (typeof input.diff !== 'string') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'unified-diff 输入缺少字符串字段 `diff`')
  }
  if (input.bundleReport !== undefined && (input.bundleReport === null || typeof input.bundleReport !== 'object')) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`bundleReport` 必须是对象 { chunk|path: bytes }（可省略）')
  }

  const base = codeReviewSource.enumerate(input, context)
  const report = input.bundleReport ?? {}
  const chunkBytesOf = (path) => {
    const direct = Number(report[path])
    if (Number.isFinite(direct) && direct > 0) return direct
    const chunk = String(path).split('/')[0]
    const byChunk = Number(report[chunk])
    return Number.isFinite(byChunk) && byChunk > 0 ? byChunk : null
  }

  const candidates = base.candidates.map((candidate) => ({
    ...candidate,
    meta: { ...candidate.meta, chunkBytes: chunkBytesOf(candidate.path) },
  }))

  const known = candidates.filter((candidate) => candidate.meta.chunkBytes !== null).length
  const notes = [...base.notes]
  if (known < candidates.length && candidates.length > 0) {
    notes.push(`${candidates.length - known} 个候选没有 bundle 体积数据 —— 体积影响未知时不得断言「不影响首屏」`)
  }

  return { candidates, excluded: base.excluded, notes, bounded: true, truncated: base.truncated }
}

export default defineCandidateSource({
  kind: 'diff-hunks',
  inputFormat: 'unified-diff',
  bounded: true,
  describe: '与 code-review 同源：unified diff -> 每个 (文件, hunk) 一个候选，复用其解析与 hunk 窗口；本领域只额外挂上 bundleReport 体积。',
  enumerate,
})
