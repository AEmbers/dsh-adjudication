/**
 * backend-engineering — P0 candidate source (contract v2, extension point 1).
 *
 * REUSE, NOT REIMPLEMENTATION
 * ---------------------------
 * The candidate set is the SAME candidate set as `code-review` — one per
 * (file, hunk) — and the parser that produces it is imported from there:
 * `parseUnifiedDiff`, `hunkLineCounts` and `hunkNewSpan` in
 * `domains/code-review/source.js`. A second diff parser in this repository
 * would be a second place for a hunk header to be mis-parsed, and the two
 * domains would drift the first time one of them was fixed.
 *
 * What this module ADDS is exactly one thing, and it is the domain's:
 * `serviceMap` — `{ '<path>': '<service>' }`, joined from the repository layout.
 * It rides on `candidate.meta.service` so a bundle can be described in service
 * terms without the engine knowing what a service is. (Note that the plugin's
 * `toCandidates()` keeps only DTO fields, which is why the P2 grouping still
 * comes from the PATH — see `bundleKey` in `index.js`.)
 *
 * DOCUMENTED INPUT FORMAT: `unified-diff` (identical to code-review)
 * -----------------------------------------------------------------
 *   {
 *     diff: string,                       // `git diff --unified=3 --no-color`
 *     files?: [{ path, bytes?, binary?, deleted?, additions?, deletions? }],
 *     serviceMap?: { '<path>': '<service>' },
 *   }
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'
import codeReviewSource, { hunkLineCounts, hunkNewSpan, parseUnifiedDiff } from '../code-review/source.js'

/** The parser is code-review's; re-exported so the domain's test can pin it. */
export { parseUnifiedDiff, hunkLineCounts, hunkNewSpan }

/**
 * The documented-input -> candidate-set function.
 *
 * Delegates to the reference implementation and then attaches the service
 * context. Delegation is the point: the hunk windowing, the binary/deleted/
 * rename branches and the "no hunks and no reviewable change" exclusion are all
 * the reference behaviour, unchanged.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'unified-diff 输入必须是对象 { diff, files?, serviceMap? }')
  }
  if (typeof input.diff !== 'string') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'unified-diff 输入缺少字符串字段 `diff`')
  }
  if (input.serviceMap !== undefined && (input.serviceMap === null || typeof input.serviceMap !== 'object')) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`serviceMap` 必须是对象 { path: service }（可省略）')
  }

  const base = codeReviewSource.enumerate(input, context)
  const serviceMap = input.serviceMap ?? {}
  const serviceOf = (path) => {
    const value = serviceMap[path]
    return typeof value === 'string' && value !== '' ? value : null
  }

  const candidates = base.candidates.map((candidate) => ({
    ...candidate,
    meta: { ...candidate.meta, service: serviceOf(candidate.path) },
  }))

  const named = candidates.filter((candidate) => candidate.meta.service !== null).length
  const notes = [...base.notes]
  if (named < candidates.length && candidates.length > 0) {
    notes.push(`${candidates.length - named} 个候选没有 serviceMap 归属 —— 服务边界未知不等于没有边界，报告里不得据此推断影响面`)
  }

  return { candidates, excluded: base.excluded, notes, bounded: true, truncated: base.truncated }
}

export default defineCandidateSource({
  kind: 'diff-hunks',
  inputFormat: 'unified-diff',
  bounded: true,
  describe: '与 code-review 同源：unified diff -> 每个 (文件, hunk) 一个候选，复用其解析与 hunk 窗口；本领域只额外挂上 serviceMap 归属。',
  enumerate,
})
