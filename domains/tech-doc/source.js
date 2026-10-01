/**
 * tech-doc — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `doc-corpus-and-api-surface`
 * -----------------------------------------------------
 * The format table in `lib/contracts.js` (`DOMAIN_INPUT_FORMATS['tech-doc']`)
 * fixes both the name and the shape, and this file implements exactly that shape:
 *
 *   {
 *     documents: [{ path, title, sections: [{ anchor, text }] }],
 *     api: [{ name, signature, params: [{ name, required, default? }], returns }]
 *   }
 *
 * and the documented candidate set: "one per (section, verifiable claim) — a
 * claim is a signature-shaped string, a fenced example, or a link".
 *
 * THREE CLAIM KINDS, AND WHY EACH ONE IS CHECKABLE
 * ------------------------------------------------
 *   signature  a line that looks like a declaration — `name(a, b): T`. The API
 *              surface lets the verifier recompute it, which is the whole point
 *              of P5 in this domain.
 *   example    a fenced code block. It is checkable because the symbols it calls
 *              either exist in the API surface or do not.
 *   link       a Markdown inline link. It is checkable because the target is a
 *              path relative to the document.
 *
 * A PROSE SENTENCE IS NOT A CLAIM
 * -------------------------------
 * This source deliberately does NOT turn every sentence into a candidate. A
 * sentence has no verification surface, so emitting one would manufacture work
 * that no reviewer could discharge — and this is a precision-first domain, where
 * an unverifiable finding is worse than a missing one. Only text that carries a
 * mechanically checkable shape becomes a candidate.
 *
 * `candidate.path` IS ALWAYS THE DOCUMENT PATH
 * --------------------------------------------
 * `path` is what the P1 gate globs, so it stays the document file. The anchor,
 * the claim kind and the API name live in `locator`. The cost is that several
 * claims of one document look like several candidates with the same `path`; that
 * is intended — `entries` are claims, not files, and P2 bundles them by document
 * on purpose.
 *
 * HONEST BOUND: at most `MAX_CLAIMS_PER_SECTION` claims are taken from any one
 * section, in document order. A section with more is reported as truncated
 * rather than silently shortened.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/** Per-section ceiling. Documented, declared in the notes, never silent. */
export const MAX_CLAIMS_PER_SECTION = 8

/** ```lang\n…\n``` — the fenced example claim. */
const FENCE_RE = /^[ \t]*```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gmu

/** `[text](target)` — the link claim. */
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)\)/gu

/**
 * A declaration-shaped line: an optional `export`/`async`/`public`, an optional
 * keyword, an identifier, a parameter list, an optional return annotation.
 *
 * Deliberately anchored at both ends of a LINE, so a sentence that merely
 * mentions a call is not mistaken for a signature.
 */
export const SIGNATURE_RE = /^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:public[ \t]+|private[ \t]+|static[ \t]+|async[ \t]+)*(?:function|def|func|fn|class|struct|interface|type)[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(([^()]*)\)[ \t]*(?::[ \t]*([^\n{]{0,80}))?[ \t]*$/u

/** `name(a: T, b?: U): R` — a bare declaration without a keyword. */
const BARE_SIGNATURE_RE = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*\(([^()]*)\)[ \t]*:[ \t]*([^\n{]{1,80})[ \t]*$/u

/** Split `a: T, b?: U` into the parameter names the doc claims. */
function claimedParams(raw) {
  return String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => part.split(/[:=?]/u)[0].trim())
    .filter((name) => name !== '')
}

/** Index the API surface by name, keeping the first declaration of each. */
function indexApi(api) {
  const byName = new Map()
  for (const entry of Array.isArray(api) ? api : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name === '') continue
    if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  return byName
}

/**
 * Extract every mechanically checkable claim from one section's text.
 *
 * @param {string} text
 * @returns {Array<{claimKind:string,text:string,apiName:string|null,line:number,detail:object}>}
 */
export function claimsInSection(text) {
  const source = String(text ?? '')
  const claims = []
  const fenced = []

  // Fenced examples first, so their body lines are not also read as signatures.
  FENCE_RE.lastIndex = 0
  let fence = FENCE_RE.exec(source)
  while (fence !== null) {
    const body = fence[2]
    claims.push({
      claimKind: 'example',
      text: fence[0],
      apiName: null,
      line: source.slice(0, fence.index).split('\n').length,
      detail: { language: fence[1] || null, code: body },
    })
    fenced.push([fence.index, fence.index + fence[0].length])
    fence = FENCE_RE.exec(source)
  }

  const inFence = (offset) => fenced.some(([start, end]) => offset >= start && offset < end)

  LINK_RE.lastIndex = 0
  let link = LINK_RE.exec(source)
  while (link !== null) {
    if (!inFence(link.index)) {
      claims.push({
        claimKind: 'link',
        text: link[0],
        apiName: null,
        line: source.slice(0, link.index).split('\n').length,
        detail: { label: link[1], target: link[2] },
      })
    }
    link = LINK_RE.exec(source)
  }

  const lines = source.split(/\r?\n/u)
  let offset = 0
  for (const [index, line] of lines.entries()) {
    const start = offset
    offset += line.length + 1
    if (inFence(start)) continue
    const match = SIGNATURE_RE.exec(line) ?? BARE_SIGNATURE_RE.exec(line)
    if (match === null) continue
    claims.push({
      claimKind: 'signature',
      text: line.trim(),
      apiName: match[1],
      line: index + 1,
      detail: { name: match[1], params: claimedParams(match[2]), returns: (match[3] ?? '').trim() || null },
    })
  }

  claims.sort((left, right) => left.line - right.line)
  return claims
}

/**
 * Enumerate the verifiable documentation claims.
 *
 * @param {{documents?:object[],api?:object[]}} input
 * @param {object} [context] `{ maxCandidates, maxExcerptLines }` — the engine's bounds
 * @returns {{candidates:object[],excluded:object[],notes:string[],bounded:boolean,truncated:boolean}}
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      'doc-corpus-and-api-surface 输入必须是对象 { documents, api }')
  }
  if (!Array.isArray(input.documents)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '输入缺少数组字段 `documents`（文档树）')
  }
  if (input.api !== undefined && !Array.isArray(input.api)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`api` 必须是数组（可省略 = 没有 API surface 可比对）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500
  const apiByName = indexApi(input.api)

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

  for (const document of input.documents) {
    if (document === null || typeof document !== 'object' || typeof document.path !== 'string' || document.path === '') {
      excluded.push({ id: '(document)', reason: 'document entry without a path — it cannot be gated or anchored' })
      continue
    }
    const sections = Array.isArray(document.sections) ? document.sections : []
    if (sections.length === 0) {
      excluded.push({ id: document.path, reason: '文档没有 section —— 没有段落锚，断言无法落到可核验的位置' })
      continue
    }

    let taken = 0
    for (const [sectionIndex, section] of sections.entries()) {
      const anchor = typeof section?.anchor === 'string' && section.anchor !== '' ? section.anchor : null
      if (anchor === null) {
        excluded.push({
          id: `${document.path}#section-${sectionIndex + 1}`,
          reason: 'section 缺少 anchor —— 没有段落锚就无法把发现落到标题上',
        })
        continue
      }
      const text = String(section?.text ?? '')
      const claims = claimsInSection(text)
      if (claims.length === 0) continue

      const annotated = claims.map((claim) => ({ claim, claimText: claim.text.split(/\r?\n/u) }))
      const kept = annotated
        .filter(({ claimText }) => claimText.length <= maxExcerptLines)
        .slice(0, MAX_CLAIMS_PER_SECTION)

      if (claims.length > MAX_CLAIMS_PER_SECTION) {
        truncated = true
        notes.push(`${document.path}#${anchor} 有 ${claims.length} 处可验证断言，按 MAX_CLAIMS_PER_SECTION ${MAX_CLAIMS_PER_SECTION} 截断`)
      }
      for (const { claimText } of annotated) {
        if (claimText.length > maxExcerptLines) {
          truncated = true
          notes.push(`${document.path}#${anchor} 的断言超过 maxExcerptLines ${maxExcerptLines}，已丢弃（不截断内容，因为半段示例无法核验）`)
        }
      }

      for (const { claim } of kept) {
        const apiEntry = claim.apiName === null ? undefined : apiByName.get(claim.apiName)
        push({
          id: `${document.path}#${anchor}#${claim.claimKind}-${claim.line}`,
          path: document.path,
          locator: {
            kind: 'doc-claim',
            docPath: document.path,
            anchor,
            apiName: claim.apiName,
            claimKind: claim.claimKind,
            line: claim.line,
          },
          text: claim.text,
          bytes: byteLength(claim.text),
          additions: 0,
          deletions: 0,
          title: `${document.path}#${anchor} — ${claim.claimKind}${claim.apiName === null ? '' : ` ${claim.apiName}`}`,
          meta: {
            kind: 'doc-claim',
            document: document.path,
            anchor,
            claimKind: claim.claimKind,
            apiName: claim.apiName,
            // Recorded for the report. The grouping reads only `path`.
            apiKnown: apiEntry !== undefined,
            ...claim.detail,
          },
        })
        taken += 1
      }
    }

    if (taken === 0) {
      notes.push(`${document.path} 没有任何可机械核验的断言（签名 / 示例 / 链接）—— 散文句子不是候选`)
    }
  }

  for (const name of apiByName.keys()) {
    const referenced = (input.documents ?? []).some((document) => (document?.sections ?? []).some((section) => (
      claimsInSection(String(section?.text ?? '')).some((claim) => claim.apiName === name)
    )))
    if (!referenced) notes.push(`API "${name}" 没有任何签名断言引用它 —— 它可能未被文档化（链接或散文提及不计入：那些没有可重算的签名）`)
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'doc-claims',
  inputFormat: 'doc-corpus-and-api-surface',
  bounded: true,
  describe: '文档树 + API surface → 每个 (段落, 可验证断言) 一个候选；断言的三种形态是签名、围栏示例、链接。',
  enumerate,
})

export { indexApi, claimedParams }
