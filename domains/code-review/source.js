/**
 * code-review — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `unified-diff`
 * --------------------------------------
 *   {
 *     diff: string,                       // `git diff --unified=3 --no-color` output
 *     files?: [{                          // optional enrichment
 *       path,                             // 新文件路径（删除的文件用旧路径）
 *       bytes?, binary?, deleted?,        // 从 `git diff --numstat` / `--name-status` 补齐
 *       additions?, deletions?, status?,
 *     }]
 *   }
 *
 * ONE CANDIDATE PER (FILE, HUNK), as `lib/contracts.js` §5 declares for this
 * domain. `candidate.path` is always the FILE path — never a synthetic
 * `file#hunk` id — because that is what the P1 gate globs; a suffixed id would
 * be rejected by the extension predicate and the whole candidate set would
 * vanish into "unsupported file type".
 *
 * WHY `bytes` IS DERIVED FROM THE EXCERPT, NOT THE FILE
 * ----------------------------------------------------
 * `GATE_FIELD_MAPPING.bytes` is "size in bytes of the material the candidate
 * would put in context", and a candidate here is a hunk, not a file. Using the
 * whole-file size would let one enormous file veto every hunk in it. When the
 * caller supplies `files[].bytes` it is used only as a fallback for files that
 * carry no hunks (binary, pure rename, mode change), where the hunk text is not
 * what enters context.
 *
 * HONESTY: this module only *enumerates*. It does not decide what is
 * reviewable — the P1 gate does, and the two boundaries the fixtures pin
 * (`empty`, `all-gated-out`) exist to prove exactly that.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

/** Matches open-code-review `internal/diff/hunk.go:36 hunkHeaderRe`. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/**
 * Lines that belong to file/diff metadata rather than hunk content. Mirrors the
 * "skip metadata lines that can appear inside hunks" branch upstream.
 */
const METADATA_PREFIXES = [
  'diff --git ', 'index ', 'new file mode ', 'deleted file mode ', 'old mode ', 'new mode ',
  'similarity index ', 'dissimilarity index ', 'rename from ', 'rename to ', 'copy from ', 'copy to ',
  'Binary files ', 'GIT binary patch',
]

const isMetadata = (line) => METADATA_PREFIXES.some((prefix) => line.startsWith(prefix))

/** `a/src/x.ts` -> `src/x.ts`; `/dev/null` stays `/dev/null`. */
function stripPrefix(path) {
  const value = String(path ?? '').trim()
  if (value === '' || value === '/dev/null') return value
  if (/^[ab]\//u.test(value)) return value.slice(2)
  return value
}

/**
 * Split a raw `diff --git <a> <b>` payload into its two paths.
 *
 * The payload is C-quoted whenever a path contains a space or a non-ASCII byte
 * (`"a/has space.ts"`), which makes the quoted form unambiguous; the unquoted
 * form only needs the `a/`/`b/` boundaries. The `---` / `+++` lines that follow
 * always override whatever this returns, so a path this cannot resolve is a
 * cosmetic loss, never a correctness one.
 */
function pathsFromGitLine(line) {
  const rest = line.slice('diff --git '.length).trim()
  const quoted = /^"(a\/.*?)" "(b\/.*?)"$/u.exec(rest)
  if (quoted !== null) return { oldPath: stripPrefix(quoted[1]), newPath: stripPrefix(quoted[2]) }
  const marker = rest.indexOf(' b/')
  if (rest.startsWith('a/') && marker > 0) {
    return { oldPath: stripPrefix(rest.slice(0, marker)), newPath: stripPrefix(rest.slice(marker + 1)) }
  }
  return { oldPath: '', newPath: '' }
}

/**
 * Parse the input into per-file records.
 * @returns {{ files: object[], problems: string[] }}
 */
export function parseUnifiedDiff(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return { files: [], problems: [] }

  const lines = source.split(/\r?\n/u).filter((line, index, all) => !(index === all.length - 1 && line === ''))
  const files = []
  const problems = []
  let file = null
  let hunk = null

  const closeHunk = () => {
    if (hunk === null) return
    if (hunk.textLines.length > 0) file.hunks.push(hunk)
    hunk = null
  }
  const closeFile = () => {
    if (file === null) return
    closeHunk()
    if (file.path === '') problems.push(`diff block at line ${file.atLine} carries no usable path`)
    else files.push(file)
    file = null
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1

    if (line.startsWith('diff --git ')) {
      closeFile()
      const paths = pathsFromGitLine(line)
      file = {
        oldPath: paths.oldPath, newPath: paths.newPath, path: paths.newPath || paths.oldPath,
        binary: false, deleted: false, isNew: false, renamed: false, hunks: [], atLine: lineNumber,
      }
      continue
    }
    if (file === null) {
      // A bare patch with no `diff --git` header (plain `--- a/x` / `+++ b/x`).
      if (line.startsWith('--- ')) {
        file = {
          oldPath: stripPrefix(line.slice(4).split('\t')[0]), newPath: '', path: '',
          binary: false, deleted: false, isNew: false, renamed: false, hunks: [], atLine: lineNumber,
        }
        continue
      }
      continue
    }

    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      closeHunk()
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        textLines: [],
      }
      continue
    }

    if (hunk !== null) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        // A new file section began without a `diff --git` line.
        closeFile()
        file = {
          oldPath: '', newPath: '', path: '',
          binary: false, deleted: false, isNew: false, renamed: false, hunks: [], atLine: lineNumber,
        }
        if (line.startsWith('+++ ')) file.newPath = stripPrefix(line.slice(4).split('\t')[0])
        continue
      }
      if (isMetadata(line)) {
        if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true
        const renameTo = /^rename to (.*)$/u.exec(line)
        if (renameTo !== null) { file.renamed = true; file.newPath = stripPrefix(renameTo[1]); file.path = file.newPath }
        const renameFrom = /^rename from (.*)$/u.exec(line)
        if (renameFrom !== null) { file.renamed = true; file.oldPath = stripPrefix(renameFrom[1]) }
        continue
      }
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      if (line === '' || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
        hunk.textLines.push(line)
        continue
      }
      // Anything else inside a hunk is not diff content; keep the parser total
      // rather than silently swallowing it.
      problems.push(`line ${lineNumber}: unrecognised line inside a hunk (kept as context): ${line.slice(0, 40)}`)
      hunk.textLines.push(line)
      continue
    }

    if (line.startsWith('--- ')) {
      file.oldPath = stripPrefix(line.slice(4).split('\t')[0])
      continue
    }
    if (line.startsWith('+++ ')) {
      file.newPath = stripPrefix(line.slice(4).split('\t')[0])
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }
    const renameTo = /^rename to (.*)$/u.exec(line)
    if (renameTo !== null) { file.renamed = true; file.newPath = stripPrefix(renameTo[1]); continue }
    const renameFrom = /^rename from (.*)$/u.exec(line)
    if (renameFrom !== null) { file.renamed = true; file.oldPath = stripPrefix(renameFrom[1]); continue }
    if (line.startsWith('new file mode ')) file.isNew = true
  }
  closeFile()

  for (const entry of files) {
    if (entry.newPath === '/dev/null') { entry.deleted = true; entry.path = entry.oldPath }
    else if (entry.newPath !== '') entry.path = entry.newPath
    else entry.path = entry.oldPath
    if (entry.hunks.length === 0 && entry.binary) entry.binary = true
  }
  return { files, problems }
}

/** Count added/removed lines in a hunk's raw text. */
export function hunkLineCounts(textLines) {
  let additions = 0
  let deletions = 0
  for (const line of textLines) {
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

/** New-file line span a hunk's raw text occupies (1-based, inclusive). */
export function hunkNewSpan(hunk) {
  const start = hunk.newStart > 0 ? hunk.newStart : 1
  const length = Math.max(1, hunk.textLines.filter((line) => !line.startsWith('-')).length)
  return { start, end: start + length - 1 }
}

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/**
 * The domain's documented-input -> candidate-set function.
 *
 * `context` is what the engine hands every source: `{ maxCandidates,
 * maxExcerptLines, include, exclude, extensions }`. The source does NOT apply
 * the gate — it only reports what it saw, so "P0 enumerated nothing" and "P1
 * removed everything" stay distinguishable in the plan.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'unified-diff 输入必须是对象 { diff, files? }')
  }
  if (typeof input.diff !== 'string') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'unified-diff 输入缺少字符串字段 `diff`')
  }
  if (input.files !== undefined && !Array.isArray(input.files)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`files` 必须是数组（可省略）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const parsed = parseUnifiedDiff(input.diff)
  const enrichment = new Map()
  for (const entry of input.files ?? []) {
    if (entry === null || typeof entry !== 'object') continue
    const key = String(entry.path ?? '')
    if (key !== '') enrichment.set(key, entry)
  }

  const candidates = []
  const excluded = []
  const notes = [...parsed.problems]
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

  const filesWithHunks = new Set()
  for (const [fileIndex, file] of parsed.files.entries()) {
    filesWithHunks.add(file.path)
    if (file.binary) {
      // Binary payload: a single candidate, never reviewable as text, so the
      // gate's `binary` predicate is the one that removes it — not the source.
      const meta = enrichment.get(file.path) ?? {}
      const size = Number(meta.bytes) > 0 ? Number(meta.bytes) : byteLength(file.path)
      push({
        id: `${file.path}#binary`,
        path: file.path,
        locator: { kind: 'binary', fileIndex },
        text: `Binary files differ: ${file.path}`,
        bytes: size,
        binary: true,
        meta: { kind: 'binary', status: meta.status ?? 'binary' },
      })
      continue
    }
    if (file.hunks.length === 0) {
      const meta = enrichment.get(file.path) ?? {}
      if (file.deleted) {
        push({
          id: `${file.path}#deleted`,
          path: file.path,
          locator: { kind: 'whole-file', fileIndex, side: 'old' },
          text: `deleted file: ${file.path}`,
          bytes: Number(meta.bytes) > 0 ? Number(meta.bytes) : byteLength(file.path),
          deleted: true,
          meta: { kind: 'deleted', status: 'deleted' },
        })
        continue
      }
      if (file.renamed) {
        push({
          id: `${file.path}#rename`,
          path: file.path,
          locator: { kind: 'whole-file', fileIndex, side: 'new' },
          text: `renamed: ${file.oldPath} -> ${file.path}`,
          bytes: Number(meta.bytes) > 0 ? Number(meta.bytes) : byteLength(file.path),
          meta: { kind: 'rename', status: 'renamed', from: file.oldPath },
        })
        continue
      }
      // Mode change / empty diff section: nothing to review, and saying so is
      // more useful than inventing a candidate.
      excluded.push({ id: file.path || `file#${fileIndex}`, reason: 'diff section carries no hunks and no reviewable change' })
      continue
    }

    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const span = hunkNewSpan(hunk)
      const counts = hunkLineCounts(hunk.textLines)
      const raw = hunk.textLines.join('\n')
      const overLimit = hunk.textLines.length > maxExcerptLines
      const text = overLimit ? hunk.textLines.slice(0, maxExcerptLines).join('\n') : raw
      if (overLimit) {
        truncated = true
        notes.push(`${file.path} hunk #${hunkIndex + 1} 超过 maxExcerptLines ${maxExcerptLines}，已截断`)
      }
      push({
        id: `${file.path}#hunk-${hunkIndex + 1}`,
        path: file.path,
        locator: { kind: 'diff-line', hunkIndex, startLine: span.start, endLine: span.end, side: file.deleted ? 'old' : 'new' },
        text,
        bytes: byteLength(text),
        additions: counts.additions,
        deletions: counts.deletions,
        // File-level facts travel with every hunk: a deleted file's hunks are
        // deletions, and every one of them must be removed by the `deleted`
        // predicate. Without this the source would have silently promoted the
        // removed lines of a deleted file into the reviewable set.
        deleted: file.deleted,
        binary: file.binary,
        meta: {
          kind: file.deleted ? 'deletion-hunk' : 'hunk',
          fileIndex,
          hunkIndex,
          oldStart: hunk.oldStart,
          oldCount: hunk.oldCount,
          newStart: hunk.newStart,
          newCount: hunk.newCount,
          clipped: overLimit,
        },
      })
    }
  }

  // Caller-supplied enrichment for a path that never appeared in the diff is a
  // malformed request, not something to silently ignore: the caller believes it
  // is reviewing a file the diff does not mention.
  for (const key of enrichment.keys()) {
    if (!filesWithHunks.has(key)) notes.push(`files[] 中的 "${key}" 未出现在 diff 里，已忽略`)
  }

  return {
    candidates,
    excluded,
    notes,
    bounded: true,
    truncated,
  }
}

export default defineCandidateSource({
  kind: 'diff-hunks',
  inputFormat: 'unified-diff',
  bounded: true,
  describe: 'unified diff -> 每个 (文件, hunk) 一个候选；二进制/删除/重命名各成一个候选，交由 P1 闸门判定。',
  enumerate,
})
