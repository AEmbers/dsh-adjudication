/**
 * tech-doc — P5 anchor verifier (contract v2, extension point 2).
 *
 * WHY THIS IS NOT A TEXT SEARCH
 * -----------------------------
 * The v1 pack states the obligation: "锚点是「文档段落锚 + 源码 API 签名」。引擎用
 * 滑窗在源码中定位该签名，验证文档描述与之一致。" So a claim survives only if
 * BOTH hold:
 *
 *   1. the copied text really is at the position the model means, AND
 *   2. for a signature claim, the signature the DOCUMENT writes is the signature
 *      the API SURFACE has — recomputed, not trusted.
 *
 * Step 2 is the reason this file exists. A verifier that only slid a window over
 * the document would answer "is this string in the file", which is a question
 * about typography, not about documentation drift. "你是技术文档评审者，评审的是
 * 文档与实现的一致性" is a claim about two artefacts, so two artefacts are read.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * - A signature claim with no API surface to compare against is UNANCHORED, not
 *   anchored-with-a-shrug. "I could not check it" must not read as "it checks
 *   out" — that is the silent-pass failure mode this whole contract is built
 *   around.
 * - A signature claim naming an API the surface does not contain is UNANCHORED.
 * - A documented parameter list that drops a required source parameter, or that
 *   invents a parameter the source does not have, is UNANCHORED.
 * - A paragraph anchor that the document structure does not contain is
 *   UNANCHORED, whenever the structure was supplied.
 *
 * MATCHING IS LITERAL. `normalizeLine` drops leading diff markers and ALL
 * whitespace (the same normalization the reference domain ports from
 * open-code-review `internal/diff/resolver.go:301`); nothing else is tolerated.
 * A renamed identifier, an added comma, a reordered parameter is a DIFFERENT
 * thing — and in this domain that difference is exactly the finding.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

/** The anchor kind this domain verifies. */
const KIND = 'section-and-signature'

function normalizeLine(line) {
  return String(line).replace(/^[+-]/u, '').replace(/\s+/gu, '')
}

function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

/** A signature reduced to its identity: all whitespace gone, nothing else. */
export function normalizeSignature(value) {
  return String(value ?? '').replace(/\s+/gu, '')
}

/** The parameter names a signature mentions, in order. */
export function signatureParams(signature) {
  const match = /\(([^()]*)\)/u.exec(String(signature ?? ''))
  if (match === null) return null
  const inner = match[1].trim()
  if (inner === '') return []
  return inner
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => part.split(/[:=?]/u)[0].trim())
    .filter((name) => name !== '')
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

const anchored = (path, start, end, tier, detail, extra = {}) => ({
  status: 'anchored', tier, path, start, end, detail, ...extra,
})

function toDocuments(subject) {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string'
      ? entry.content
      : (Array.isArray(entry.sections) ? entry.sections.map((section) => String(section?.text ?? '')).join('\n') : '')
    if (path !== '') documents.push({ path, content, sections: Array.isArray(entry.sections) ? entry.sections : null })
  }
  return documents
}

/** The API surface, however the caller supplied it. */
function toApi(subject) {
  if (Array.isArray(subject?.api)) return subject.api
  if (subject?.api !== null && typeof subject?.api === 'object') {
    return Object.entries(subject.api).map(([name, entry]) => (
      entry !== null && typeof entry === 'object' ? { name, ...entry } : { name, signature: String(entry) }
    ))
  }
  return null
}

/**
 * The signature check. Returns `null` when the claim does not assert a
 * signature; otherwise `{ok, reason}`.
 */
function signatureCheck(locator, excerpt, subject) {
  const apiName = typeof locator?.apiName === 'string' && locator.apiName !== '' ? locator.apiName : null
  if (apiName === null) return null

  const api = toApi(subject)
  if (api === null) {
    return {
      ok: false,
      reason: `这条断言声称文档与 API "${apiName}" 一致，但没有提供 API surface —— 无法重算签名。'
        + '「无法核验」不是「一致」，因此不予锚定。`,
    }
  }
  const entry = api.find((item) => item?.name === apiName)
  if (entry === undefined) {
    return {
      ok: false,
      reason: `API surface 里没有 "${apiName}" —— 文档引用了不存在（或未导出）的 API。`
        + `surface 中有：${api.map((item) => item?.name).filter(Boolean).slice(0, 20).join(', ') || '(空)'}`,
    }
  }
  const documented = normalizeSignature(excerpt)
  const actual = normalizeSignature(entry.signature)
  if (actual === '') {
    return { ok: false, reason: `API surface 里的 "${apiName}" 没有 signature 字段 —— 没有可重算的基准，不予锚定` }
  }
  if (documented !== actual) {
    return {
      ok: false,
      reason: `文档写出的签名与 API surface 重算出的签名不一致：文档 "${String(excerpt).trim()}" vs 源码 "${entry.signature}"`,
    }
  }

  // Second, independent check: a documented parameter list that drops a required
  // source parameter, or invents one the source does not have, is drift even
  // when the rendered signature happens to normalize the same way.
  const docParams = signatureParams(excerpt)
  const apiParams = Array.isArray(entry.params) ? entry.params : null
  if (docParams !== null && apiParams !== null) {
    const apiNames = apiParams.map((param) => String(param?.name ?? '')).filter((name) => name !== '')
    const missingRequired = apiParams
      .filter((param) => param?.required === true)
      .map((param) => String(param?.name ?? ''))
      .filter((name) => name !== '' && !docParams.includes(name))
    if (missingRequired.length > 0) {
      return { ok: false, reason: `文档漏掉了必填参数：${missingRequired.join(', ')}（源码里它们没有默认值）` }
    }
    const invented = docParams.filter((name) => !apiNames.includes(name))
    if (invented.length > 0) {
      return { ok: false, reason: `文档写出了源码签名里没有的参数：${invented.join(', ')}` }
    }
  }
  return { ok: true, reason: `签名与 API surface 的 "${apiName}" 逐字一致（${entry.signature}）` }
}

/** The paragraph-anchor check, skipped only when no structure was supplied. */
function anchorCheck(locator, document) {
  const anchor = typeof locator?.anchor === 'string' && locator.anchor !== '' ? locator.anchor : null
  if (anchor === null) return { checked: false, ok: true, reason: '未声明段落锚' }
  const sections = Array.isArray(document?.sections) ? document.sections : null
  if (sections === null) {
    return { checked: false, ok: true, reason: '调用方未提供文档结构，段落锚未核验（签名核验不受影响）' }
  }
  const found = sections.some((section) => section?.anchor === anchor)
  if (!found) {
    return {
      checked: true,
      ok: false,
      reason: `文档结构里没有段落锚 "${anchor}" —— 发现落在一个不存在的标题上。`
        + `实际有：${sections.map((section) => section?.anchor).filter(Boolean).join(', ') || '(空)'}`,
    }
  }
  return { checked: true, ok: true, reason: `段落锚 "${anchor}" 存在` }
}

/**
 * Verify one documentation-consistency anchor claim.
 *
 * @param {{kind?:string,path?:string,locator?:object,excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:object[],api?:object[]|object,sections?:object[]}} subject
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
    ? { path: preferred, content: subjectContent, sections: Array.isArray(subject?.sections) ? subject.sections : null }
    : documents.find((document) => document.path === preferred) ?? null
  const others = documents.filter((document) => document.path !== preferred)

  if (named === null && documents.length === 0) {
    return unanchored('no-documents', '没有提供任何可比对的文档 —— 无法重算锚点')
  }

  /** Everything that must hold once a position is established. */
  const finish = (path, start, end, tier, base, document) => {
    const anchorResult = anchorCheck(locator, document)
    if (!anchorResult.ok) return unanchored('locator-mismatch', `${base}；但 ${anchorResult.reason}`)
    const signatureResult = signatureCheck(locator, claim.excerpt, subject)
    if (signatureResult !== null && !signatureResult.ok) {
      return unanchored('locator-mismatch', `${base}；但 ${signatureResult.reason}`)
    }
    const parts = [base, anchorResult.reason]
    if (signatureResult !== null) parts.push(signatureResult.reason)
    return anchored(path, start, end, tier, parts.join('；'), { anchorChecked: anchorResult.checked })
  }

  if (named !== null) {
    const declared = locator.startLine ?? locator.line
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return finish(named.path, declared, declared + needle.length - 1, 'declared-locator',
          `第 ${declared} 行确认无误`, named)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }

    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return finish(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号`, named)
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
      hits.push({ path: document.path, start: hit.start, end: hit.end, document })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return finish(only.path, only.start, only.end, 'relocated-unique',
      `声明的 "${preferred}" 不在可比对文档中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁`, only.document)
  }
  if (hits.length > 1) {
    return unanchored('relocation-ambiguous',
      `声明的 "${preferred}" 不在可比对文档中，且原文在 ${hits.length} 处命中 —— 跨文件搬迁不唯一，拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${hit.path}:${hit.start}`) })
  }
  return unanchored('no-match', `声明的 "${preferred}" 与任何可比对文档都不含这段原文`)
}

export default defineAnchorVerifier({
  kind: KIND,
  verifyLevel: 'engine-recomputable',
  describe: '段落锚 + API 签名锚点：逐字重算断言位置，并把文档写出的签名与 API surface 重算出的签名逐项比对；无 surface 可比、签名不一致、段落锚不存在时一律未锚定。',
  verify,
})

export { allMatches, matchesAt, toApi, signatureCheck, anchorCheck }
