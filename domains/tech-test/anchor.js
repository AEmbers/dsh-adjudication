/**
 * tech-test — P5 anchor verifier (contract v2, extension point 2).
 *
 * WHAT IT VERIFIES, AND WHY THERE ARE TWO CHECKS
 * ---------------------------------------------
 * The v1 pack states the obligation: "锚点是「用例 ID + 代码行」。引擎校验该用例
 * 存在，且该行确实在其执行路径上。" So a claim survives only if BOTH hold:
 *
 *   1. the copied code line really is at the position the model means; and
 *   2. that position is NOT covered — no case's coverage touches it.
 *
 * Check 2 is what makes this an anchor rather than a text search. A model that
 * quotes a well-covered line and calls it a coverage gap is making a claim the
 * coverage report directly contradicts, and a contradiction is UNANCHORED, never
 * a discussion. This is the domain's version of "the locator contradicts the
 * subject".
 *
 * WHY THE MODEL STILL MUST NOT EMIT LINE NUMBERS
 * ---------------------------------------------
 * `locator.startLine` is treated as a CLAIM TO BE TESTED, not as an input. If it
 * is present and the excerpt is not there, the verdict is `locator-mismatch`
 * (terminal) — the model is not trusted over the file. If it is absent, the span
 * is recomputed from the excerpt by the sliding window, and check 2 then runs
 * against the RECOMPUTED span. There is no path in this file that returns a
 * position a human could not reproduce from the excerpt alone.
 *
 * MATCHING IS LITERAL. `normalizeLine` drops leading diff markers and ALL
 * whitespace (ported from open-code-review `internal/diff/resolver.go:301`);
 * nothing else is tolerated. A renamed identifier, an added semicolon, a
 * reordered expression is a DIFFERENT line. That is the whole reason the anchor
 * is worth having.
 *
 * BOTH CHECKS, OR NOTHING (CHANGED, t23)
 * --------------------------------------
 * Check 2 is fail-closed: with no coverage entry for the claimed path the verdict
 * is UNANCHORED, not "anchored but unverified". See the note on `coverageCheck`
 * for the measurement that motivated it. The coverage report may arrive either as
 * `subject.coverage` (the library shape the fixtures use) or on the engine's
 * forwarded `subject.document` — see `toCoverage`.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

/** The anchor kind this domain verifies. */
const KIND = 'case-and-covered-line'

function normalizeLine(line) {
  return String(line).replace(/^[+-]/u, '').replace(/\s+/gu, '')
}

function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

/** Every place `needle` appears in `content`, as 1-based inclusive spans. */
function allMatches(content, needle) {
  if (needle.length === 0) return []
  const lines = String(content).split(/\r?\n/u).map(normalizeLine)
  const hits = []
  for (let start = 0; start + needle.length <= lines.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[start + offset] !== needle[offset]) { matched = false; break }
    }
    if (matched) hits.push({ start: start + 1, end: start + needle.length })
  }
  return hits
}

function matchesAt(content, needle, startLine) {
  const lines = String(content).split(/\r?\n/u)
  if (startLine < 1 || startLine + needle.length - 1 > lines.length) return false
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (normalizeLine(lines[startLine - 1 + offset]) !== needle[offset]) return false
  }
  return true
}

const unanchored = (tier, detail, extra = {}) => ({
  status: 'unanchored', tier, path: null, start: null, end: null, detail, ...extra,
})

const anchored = (path, start, end, tier, detail) => ({
  status: 'anchored', tier, path, start, end, detail,
})

function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string' ? entry.content : (typeof entry.text === 'string' ? entry.text : '')
    if (path !== '') documents.push({ path, content })
  }
  return documents
}

/**
 * Normalise `subject.coverage` into `Map<path, Set<line>>`.
 *
 * Three shapes are accepted, because the same coverage numbers reach the
 * verifier from three places and rejecting any of them would silently disable
 * the coverage check — which is the one check that makes this an anchor rather
 * than a text search:
 *
 *   1. `{ files: { '<path>': { lines: { '<n>': count } } } }`  the documented P0 shape
 *   2. `[{ path, lines: [n, [a,b]] }]`                          the compact form
 *   3. `{ '<path>': [n, [a,b]] }`                                a bare map
 */
function toCoverage(subject) {
  const map = new Map()
  const add = (path, list) => {
    const lines = new Set()
    if (Array.isArray(list)) {
      for (const item of list) {
        if (Array.isArray(item)) {
          for (let line = Number(item[0]); line <= Number(item[1]); line += 1) lines.add(line)
        } else if (Number.isFinite(Number(item))) lines.add(Number(item))
      }
    } else if (list !== null && typeof list === 'object') {
      for (const [key, count] of Object.entries(list)) {
        const line = Number(key)
        if (Number.isFinite(line) && Number(count ?? 0) > 0) lines.add(line)
      }
    }
    map.set(path, lines)
  }

  const raw = subject?.coverage
    // CHANGED (t23): the engine's verifier call site hands over
    // `{ path, content, document, documents }` — the coverage report does not
    // travel as `subject.coverage`, but the matched document is forwarded whole
    // (`toDocuments` in the engine spreads every field), so a caller that has a
    // report can put it there and have it found. Without this fallback the check
    // below could never run on the plugin path at all.
    ?? subject?.document?.coverage
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
      add(entry.path, entry.lines)
    }
    return map
  }
  if (raw !== null && typeof raw === 'object') {
    const files = raw.files !== null && typeof raw.files === 'object' ? raw.files : raw
    for (const [path, entry] of Object.entries(files)) {
      const list = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.lines : entry
      add(path, list)
    }
  }
  return map
}

/** Which lines of the span carry coverage. */
function coveredWithin(start, end, lines) {
  const hit = []
  if (lines === undefined) return hit
  for (let line = start; line <= end; line += 1) if (lines.has(line)) hit.push(line)
  return hit
}

/**
 * Verify one coverage-gap anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:object[],coverage?:object|object[]}} subject
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

  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', '抄写的原文规范化后为空 —— 没有可核验的内容，不得据以出结论')
  }

  const locator = claim.locator ?? {}
  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const documents = toDocuments(subject)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent }
    : documents.find((document) => document.path === preferred) ?? null
  const others = documents.filter((document) => document.path !== preferred)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', '没有提供任何可比对的源码 —— 无法重算锚点')
  }

  /** The coverage check, applied to whatever span we ended up with. */
  const coverageCheck = (path, start, end) => {
    const lines = toCoverage(subject).get(path)
    if (lines === undefined) {
      // CHANGED (t23). This used to return `{ok: true}`, i.e. an absent coverage
      // entry produced an ANCHORED verdict — the exact opposite of this file's
      // contract (see the header: check 2 "is what makes this an anchor rather
      // than a text search", and a claim survives only if BOTH checks hold).
      // Measured before the change: the same assertion came back UNANCHORED when
      // the line was hit 7 times and the report was supplied, and ANCHORED when
      // the report was simply left out — so withholding evidence bought the
      // claim a pass. The other three domains in this family refuse when the
      // table is missing; this one was the exception.
      //
      // "unknown" is not "verified". Refusing is the only direction that cannot
      // be farmed by leaving data out.
      return { ok: false, reason: `没有提供 ${path} 的覆盖数据 —— 「该行未被任何用例覆盖」这一主张无法核验。「无法核验」不是「成立」，因此不予锚定。` }
    }
    const hit = coveredWithin(start, end, lines)
    if (hit.length > 0) {
      return { ok: false, reason: `${path}:${start}-${end} 的第 ${hit.join(', ')} 行已被覆盖报告命中 —— 「未覆盖分支」的主张与覆盖数据矛盾` }
    }
    const declaredCases = Array.isArray(locator.exercisingCases) ? locator.exercisingCases : []
    if (declaredCases.length > 0) {
      return { ok: false, reason: `该分支被声明为由用例 ${declaredCases.join(', ')} 执行，但覆盖数据里这些行没有任何命中 —— 两种说法互相矛盾` }
    }
    return { ok: true, reason: `${path}:${start}-${end} 在覆盖报告中没有任何命中，缺口主张成立` }
  }

  const finish = (path, start, end, tier, base) => {
    const check = coverageCheck(path, start, end)
    if (!check.ok) return unanchored('locator-mismatch', `${base}；但 ${check.reason}`)
    return anchored(path, start, end, tier, `${base}；${check.reason}`)
  }

  if (named !== null) {
    const declared = locator.startLine
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return finish(named.path, declared, declared + needle.length - 1, 'declared-locator',
          `第 ${declared} 行确认无误`)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }

    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return finish(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号`)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁`)
    }
    return unanchored('relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测，请补足上下文后重抄`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }

  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return finish(only.path, only.start, only.end, 'relocated-unique',
      `声明的 "${preferred}" 不在可比对源码中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁`)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对源码中，且原文在 ${hits.length} 处命中 —— 跨文件搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  return unanchored('no-match', `声明的 "${preferred}" 与任何可比对源码都不含这段原文`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '用例-覆盖缺口锚点：逐字重算代码行位置，并用覆盖报告核验该行确实没有命中；行号与原文矛盾、或被覆盖数据正面否定时一律未锚定。',
  verify,
})

export { allMatches, matchesAt, toCoverage, coveredWithin }
