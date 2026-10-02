/**
 * tech-test — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `test-inventory-and-coverage`
 * -----------------------------------------------------
 * The format table in `lib/contracts.js` (`DOMAIN_INPUT_FORMATS['tech-test']`)
 * fixes both the name and the shape, and this file implements exactly that shape:
 *
 *   {
 *     cases: [{ id, file, assertions: [{ kind, target }] }],
 *     coverage: { files: { '<path>': { lines: { '<n>': count }, branches: { '<key>': count } } } },
 *     source:   { '<path>': { lines: string[] } }
 *   }
 *
 * and the documented candidate set: "one per uncovered line or branch, plus one
 * per weak-assertion case".
 *
 * WHY UNCOVERED LINES COME FROM THE COVERAGE REPORT, NOT FROM THE FILE
 * --------------------------------------------------------------------
 * Only lines the report LISTS are judged. A line that is absent from
 * `coverage.files[path].lines` is *unmeasured*, not uncovered, and reporting it
 * as a gap would turn every comment and blank line into a finding. A line listed
 * with count 0 is a real, measured, never-executed line — that is a gap, and it
 * is a fact rather than an inference.
 *
 * Consecutive never-executed lines are merged into ONE span. That is a
 * deliberate reading of "one per uncovered line": a 40-line unexecuted block is
 * one thing to look at, not 40, and 40 candidates would spend the candidate
 * budget on a single finding. The span is reported in the locator, so nothing is
 * lost — `startLine`/`endLine` still name every line involved.
 *
 * BRANCH KEYS ARE OPAQUE, AND THAT IS SAID OUT LOUD
 * -------------------------------------------------
 * `branches` is a free-form map. The convention this domain reads is
 * `<kind>@<line>` (e.g. `if@12`), which is what lcov/cobertura exporters emit.
 * A key that does not follow it still produces a candidate — with `branchLine:
 * null` — because dropping a never-taken branch for having an unexpected key
 * would silently lose exactly the findings the report is for.
 *
 * WHY `path` IS ALWAYS A REAL FILE PATH
 * -------------------------------------
 * `candidate.path` is what the P1 gate globs, so it stays the file the gap lives
 * in (source file for coverage gaps, test file for weak-assertion cases). It is
 * never `src/a.ts#branch-if@12`. The identity lives in `id` and `locator`.
 *
 * `meta` CARRIES NOTHING THE GROUPING NEEDS
 * -----------------------------------------
 * `index.js toCandidates()` copies only `{path, bytes, additions, deletions,
 * binary, deleted, key}` off a candidate, so `bundleKey.resolve` can only use
 * `path` — see `index.js`, which groups by the path's module root for exactly
 * this reason.
 *
 * HONEST BOUNDARY: `WEAK_ASSERTION_KINDS` below is a domain judgement, not a
 * published standard. It is agent-drafted and needs expert review.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/**
 * Assertion kinds that do not pin down behaviour. AGENT-DRAFTED JUDGEMENT —
 * there is no standards body for this, and a project that names its assertion
 * kinds differently will need its own list. A case whose assertions are ALL in
 * this set cannot fail when the implementation changes, which is the property
 * being reported.
 */
export const WEAK_ASSERTION_KINDS = Object.freeze([
  'no-throw', 'not-null', 'truthy', 'defined', 'exists', 'smoke', 'no-error',
])

/** First `depth` path segments — the module root a gap belongs to. */
function moduleRoot(path, depth = 2) {
  const parts = String(path ?? '').replace(/\\/gu, '/').split('/')
  parts.pop()
  if (parts.length === 0) return '.'
  return parts.slice(0, Math.min(depth, parts.length)).join('/')
}

/** `branches` key `<kind>@<line>` -> line, or null when the key is not that shape. */
function branchLine(key) {
  const match = /@(\d+)$/u.exec(String(key))
  if (match === null) return null
  const line = Number(match[1])
  return Number.isInteger(line) && line >= 1 ? line : null
}

/** Contiguous runs of ascending integers -> `[[start,end], …]`. */
function toSpans(numbers) {
  const spans = []
  let start = null
  let previous = null
  for (const value of numbers) {
    if (start === null) { start = value; previous = value; continue }
    if (value === previous + 1) { previous = value; continue }
    spans.push([start, previous])
    start = value
    previous = value
  }
  if (start !== null) spans.push([start, previous])
  return spans
}

/**
 * Enumerate the coverage gaps and weak-assertion cases.
 *
 * @param {{cases?:object[],coverage?:object,source?:object}} input
 * @param {object} [context] `{ maxCandidates, maxExcerptLines }` — the engine's bounds
 * @returns {{candidates:object[],excluded:object[],notes:string[],bounded:boolean,truncated:boolean}}
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      'test-inventory-and-coverage 输入必须是对象 { cases, coverage, source }')
  }
  if (!Array.isArray(input.cases)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少数组字段 `cases`（用例清单）')
  }
  if (input.coverage !== undefined && (input.coverage === null || typeof input.coverage !== 'object' || Array.isArray(input.coverage))) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`coverage` 必须是对象 { files: {…} }（可省略 = 完全没有覆盖数据）')
  }
  if (input.source !== undefined && (input.source === null || typeof input.source !== 'object' || Array.isArray(input.source))) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`source` 必须是对象 { "<path>": { lines } }（可省略 = 没有源码快照）')
  }
  // CHANGED (input-format): the OUTER `coverage`/`source` were validated; the
  // maps INSIDE them were not. A malformed map was then read as "empty", and
  // `coverage.files: "…"` does not produce a smaller review — it produces
  // SIXTEEN exclusions, i.e. the domain asserts that files are unexecuted on the
  // strength of a field it could not read. A shape the contract does not allow
  // is now refused, for the same reason the sibling copy is: the empty state is
  // a claim here, not an absence.
  if (input.coverage?.files !== undefined && input.coverage?.files !== null
    && (typeof input.coverage.files !== 'object' || Array.isArray(input.coverage.files))) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      '`coverage.files` 必须是对象 { "<path>": { lines, branches? } }'
      + ' —— 传别的形状会被读成「一个文件都没覆盖」，而那是一条关于被测对象的断言，不是「没给数据」')
  }
  if (input.coverage?.files !== undefined && input.coverage?.files !== null) {
    for (const [path, entry] of Object.entries(input.coverage.files)) {
      if (entry === undefined || entry === null) continue
      if (typeof entry !== 'object' || Array.isArray(entry)) {
        throw contractError(ERROR_CODES.E_INPUT_FORMAT,
          `\`coverage.files["${path}"]\` 必须是对象 { lines, branches? }，收到 ${Array.isArray(entry) ? 'array' : typeof entry}`
          + ' —— 非法形状会被读成「这个文件没有被执行」，于是凭空多出一条未覆盖')
      }
    }
  }
  if (input.source !== undefined && input.source !== null) {
    for (const [path, entry] of Object.entries(input.source)) {
      if (entry === undefined || entry === null) continue
      if (typeof entry !== 'object' || Array.isArray(entry)) {
        throw contractError(ERROR_CODES.E_INPUT_FORMAT,
          `\`source["${path}"]\` 必须是对象 { lines }，收到 ${Array.isArray(entry) ? 'array' : typeof entry}`
          + ' —— 非法形状会被读成「没有源码快照」，于是这个文件凭空多出一条未覆盖')
      }
    }
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const source = input.source ?? {}
  const coverageFiles = input.coverage?.files ?? {}

  /**
   * Files the test inventory names as test material.
   *
   * The SAME snapshot serves two roles: source files whose line coverage is
   * judged, and test files quoted as evidence for a weak-assertion case. A test
   * file is routinely absent from a coverage report (most projects do not
   * instrument their own tests), so treating its absence as "this whole file is
   * unexecuted" would report a gap that is an artifact of the report's scope.
   * So: absence is excused for a file the inventory calls a test.
   *
   * Excused only for ABSENCE. A report that explicitly lists a test file with
   * zero-hit lines is a measurement, and it is reported like any other.
   */
  const testFiles = new Set(
    (input.cases ?? [])
      .map((item) => (item !== null && typeof item === 'object' && typeof item.file === 'string' ? item.file : null))
      .filter((file) => file !== null && file !== ''),
  )

  const candidates = []
  const excluded = []
  const notes = []
  let truncated = false

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (candidates.some((existing) => existing.id === candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过`)
      return false
    }
    candidates.push(candidate)
    return true
  }

  const linesOf = (path) => {
    const entry = source[path]
    const lines = entry?.lines
    return Array.isArray(lines) ? lines.map((line) => String(line)) : null
  }

  /** Build the excerpt for a 1-based inclusive span, honouring maxExcerptLines. */
  const excerpt = (path, startLine, endLine, lines) => {
    if (lines === null) return ''
    const from = Math.max(1, startLine)
    const to = Math.min(lines.length, endLine)
    if (from > to) return ''
    const raw = lines.slice(from - 1, to)
    if (raw.length > maxExcerptLines) {
      truncated = true
      notes.push(`${path}:${startLine}-${endLine} 超过 maxExcerptLines ${maxExcerptLines}，已截断`)
      return raw.slice(0, maxExcerptLines).join('\n')
    }
    return raw.join('\n')
  }

  // --- (A) uncovered lines, (B) uncovered branches ---------------------------
  for (const path of Object.keys(source)) {
    const lines = linesOf(path)
    if (lines === null) {
      excluded.push({ id: path, reason: 'source 条目没有 `lines` 数组 —— 没有可抄写的原文，无法陈述缺口' })
      continue
    }
    const covFile = coverageFiles[path]

    if (covFile === undefined) {
      // The file exists in the snapshot but not in the report. That is "zero
      // coverage" only when the report DOES cover other files, and only for a
      // file the inventory does not call a test — see `testFiles` above.
      if (testFiles.has(path)) continue
      if (lines.length === 0) continue
      push({
        id: `${path}#lines-1-${lines.length}`,
        path,
        locator: { kind: 'uncovered-lines', path, startLine: 1, endLine: lines.length, side: 'source' },
        text: excerpt(path, 1, lines.length, lines),
        bytes: byteLength(excerpt(path, 1, lines.length, lines)),
        additions: 0,
        deletions: 0,
        title: `${path}:1-${lines.length}（该文件没有任何覆盖数据）`,
        meta: {
          kind: 'uncovered-lines',
          module: moduleRoot(path),
          uncoveredLines: lines.length,
          reported: false,
        },
      })
      continue
    }

    const lineHits = covFile?.lines ?? {}
    const uncovered = Object.keys(lineHits)
      .map((key) => Number(key))
      .filter((line) => Number.isInteger(line) && line >= 1 && Number(lineHits[String(line)] ?? 0) === 0)
      .sort((left, right) => left - right)

    for (const [start, end] of toSpans(uncovered)) {
      const text = excerpt(path, start, end, lines)
      push({
        id: `${path}#lines-${start}-${end}`,
        path,
        locator: { kind: 'uncovered-lines', path, startLine: start, endLine: end, side: 'source' },
        text,
        bytes: byteLength(text),
        additions: 0,
        deletions: 0,
        title: `${path}:${start}-${end}`,
        meta: { kind: 'uncovered-lines', module: moduleRoot(path), uncoveredLines: end - start + 1, reported: true },
      })
    }

    if (Object.keys(lineHits).length === 0) {
      notes.push(`${path} 的覆盖条目里没有任何行记录 —— 无法判断哪些行未被执行`)
    }

    const branchHits = covFile?.branches ?? {}
    const taken = Object.keys(branchHits)
      .filter((key) => Number(branchHits[key] ?? 0) === 0)
      .sort()
    for (const key of taken) {
      const line = branchLine(key)
      const text = line === null ? '' : excerpt(path, line, line, lines)
      push({
        id: `${path}#branch-${key}`,
        path,
        locator: { kind: 'uncovered-branch', path, branch: key, branchLine: line, startLine: line, endLine: line, side: 'source' },
        text,
        bytes: byteLength(text),
        additions: 0,
        deletions: 0,
        title: line === null ? `${path} 分支 ${key} 从未被走到` : `${path}:${line} 分支 ${key} 从未被走到`,
        meta: { kind: 'uncovered-branch', module: moduleRoot(path), branch: key },
      })
    }
  }

  // A coverage entry naming a file that the snapshot does not contain cannot be
  // turned into a quotable excerpt — say so instead of emitting an empty one.
  for (const path of Object.keys(coverageFiles)) {
    if (!Object.hasOwn(source, path)) {
      excluded.push({ id: path, reason: '覆盖报告提到该文件，但 source 快照里没有它 —— 无法抄写原文，因此无法锚定缺口' })
    }
  }

  // --- (C) weak-assertion cases ---------------------------------------------
  for (const item of input.cases) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id === '') {
      excluded.push({ id: '(case)', reason: 'case entry without a string id — it cannot be referenced or anchored' })
      continue
    }
    const assertions = Array.isArray(item.assertions) ? item.assertions : []
    const kinds = assertions.map((assertion) => (typeof assertion?.kind === 'string' ? assertion.kind : '')).filter((kind) => kind !== '')
    const weak = assertions.length === 0
      ? 'no-assertions'
      : (kinds.length === assertions.length && kinds.every((kind) => WEAK_ASSERTION_KINDS.includes(kind)) ? 'all-assertions-weak' : null)
    if (weak === null) continue

    const file = typeof item.file === 'string' ? item.file : ''
    if (file === '') {
      excluded.push({ id: item.id, reason: '弱断言用例没有 `file` —— 无法把主张落到一个可锚定的文件上' })
      continue
    }
    const lines = linesOf(file)
    if (lines === null) {
      // Without the test body there is nothing to quote, and an unquotable
      // finding is an unanchorable one. Refusing beats inventing an excerpt.
      excluded.push({ id: item.id, reason: `弱断言用例 ${item.id} 的测试文件 "${file}" 不在 source 快照里 —— 没有可抄写的原文` })
      continue
    }
    const text = excerpt(file, 1, lines.length, lines)
    push({
      id: `case-${item.id}`,
      path: file,
      locator: {
        kind: 'weak-assertion',
        path: file,
        caseId: item.id,
        assertionKinds: kinds,
        startLine: 1,
        endLine: lines.length,
        side: 'test',
      },
      text,
      bytes: byteLength(text),
      additions: 0,
      deletions: 0,
      title: `用例 ${item.id}：${weak === 'no-assertions' ? '没有任何断言' : `只有弱断言（${kinds.join(', ')}）`}`,
      meta: { kind: 'weak-assertion', module: moduleRoot(file), caseId: item.id, assertionKinds: kinds, weakReason: weak },
    })
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'cases-and-covered-lines',
  inputFormat: 'test-inventory-and-coverage',
  bounded: true,
  describe: '用例清单 + 覆盖报告 + 源码快照 → 每个「被报告为 0 命中的连续行区间」、每个「从未走到的分支」、每个「弱断言用例」一个候选。',
  enumerate,
})

export { moduleRoot, branchLine, toSpans }
