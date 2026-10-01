/**
 * ui-visual — P5 anchor verifier (contract v2, extension point 2).
 *
 * THE ANCHOR MUST BE RECOMPUTABLE AGAINST THE TOKEN TABLE
 * -------------------------------------------------------
 * "Layer X hardcodes a value where token Y should be used" is only checkable if
 * three independent facts can be recomputed by the engine:
 *
 *   1. the LAYER exists in the layer table;
 *   2. the PROPERTY exists on that layer — and the layer has NOT declared a
 *      `tokenRef` for it. A layer that already references a token contradicts
 *      the claim that the value is hardcoded, and the contradiction is refused
 *      rather than averaged away;
 *   3. the TOKEN NAME exists in the token table.
 *
 * On top of that, the quoted text must re-locate through the same literal ladder
 * the rest of the package uses. All four must hold for `anchored`.
 *
 * Refusing (3) is the whole point of this domain: without it a model can cite a
 * token that does not exist, and the "should have used a token" conclusion
 * becomes unfalsifiable.
 *
 * CONTRAST IS A COMPUTED NUMBER
 * -----------------------------
 * `contrastRatio(fg, bg)` below implements WCAG 2.x relative luminance. The
 * `contrast_ratio` evidence tool returns the very same number. A rule that says
 * "insufficient contrast" is not checkable; `4.54` against the `4.5` threshold
 * is. The function THROWS on an unparseable colour instead of guessing — an
 * anchor that silently treats a malformed value as black would quietly turn a
 * failing ratio into a passing one.
 *
 * WHERE THE STRUCTURE COMES FROM — the shared (b)-family convention
 * ----------------------------------------------------------------
 * `subject.layers` / `subject.tokens` are the original design input, and when
 * the caller can hand them over they win: they are the authoritative tables.
 *
 * In the real plugin path the caller CANNOT hand them over. The engine builds
 * the verifier's subject from the documents a finding quotes (`{path, content,
 * document, documents}`) plus `candidates` (index.js:797-803) — and a token
 * table is not text in any document, so no `documents` entry can carry it. The
 * tables are the P0 `input.payload`, which `source.js` already consumed and left
 * behind as the candidate set.
 *
 * THE CONVENTION (contract §1.2 declares `subject.candidates` as "P0 产出，
 * locator 空间在这里"; the engine now honours it — index.js:789-803): the
 * candidate set is the authoritative source of this domain's locator space, and
 * the verifier REBUILDS what it needs from it. For this domain that is the
 * `{layerId, prop, tokenName}` space: every admitted candidate contributes its
 * `locator.layerId` / `locator.prop` to a layer -> props table, and its resolved
 * token (`locator.tokenName` plus the group/value `source.js` recorded on
 * `meta`) to the token table those props are checked against.
 *
 * This is a REBUILD, NOT A BYPASS. The rebuilt tables go through exactly the
 * same checks as declared ones, so a claim naming a layer, property or token
 * that is in no candidate is still `no-match`; and when neither the declared
 * tables nor a candidate set is available the verdict is still `no-documents` —
 * "I was given nothing to recompute against" never becomes "fine, then".
 *
 * DOCUMENTED LIMIT OF THE REBUILD: only the properties that BECAME candidates
 * are in the rebuilt layer table, and only the tokens some candidate resolved to
 * are in the rebuilt token table. Consequently the "this property already
 * declares a tokenRef" contradiction cannot fire from a candidate set alone — a
 * correctly tokenised property never becomes a candidate in the first place, so
 * the candidate set has no way to show it. That check needs the declared layer
 * table, and the domain's `test.mjs` proves it still refuses in that shape.
 *
 * The same convention is what the other (b)-family domains adopt, so t21 can
 * hold all five to one rule: *the P0 candidate set is the locator space; rebuild
 * from `candidate.locator`, never invent it.*
 *
 * TIER MAPPING (the tier vocabulary is closed — `ANCHOR_TIERS` in
 * `lib/contracts.js` — so domain-specific refusals map onto it explicitly)
 * ---------------------------------------------------------------------
 *   layerId / prop / tokenName missing, unknown, or contradicted .... `no-match`
 *   excerpt empty .................................................. `empty-excerpt`
 *   no layer/token table and no candidate set to rebuild them from .. `no-documents`
 *   every evidence-ladder failure .................................. `locator-mismatch`
 *                                                                  / `relocation-ambiguous`
 *                                                                  / `no-match`
 *                                                                  / `kind-mismatch`
 *
 * PORTING: `normalizeLine` and the sliding-window match are the same idiom
 * NOTICE already lists for lib/engine.js and domains/code-review/anchor.js
 * (ported from open-code-review, `internal/diff/resolver.go`). The same
 * deviation applies: the ladder ends at "unanchored" — there is no LLM
 * re-location tier. Everything above the ladder (the layer/prop/token-table
 * recomputation and the WCAG contrast formula) is original to this domain.
 */

import { ERROR_CODES, contractError, defineAnchorVerifier } from '../../lib/contracts.js'

function normalizeLine(line) {
  return String(line).replace(/\s+/gu, '')
}

function normalizeExcerpt(excerpt) {
  return String(excerpt)
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((line) => line.length > 0)
}

const KIND = 'layer-and-token'

const lineCount = (content) => String(content).split(/\r?\n/u).length

function allMatches(content, needle) {
  if (needle.length === 0) return []
  const lines = String(content).split(/\r?\n/u)
  const normalised = lines.map(normalizeLine)
  const hits = []
  for (let start = 0; start + needle.length <= normalised.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (normalised[start + offset] !== needle[offset]) { matched = false; break }
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

// ---------------------------------------------------------------------------
// WCAG contrast — a number, computed here, reused by the evidence toolkit
// ---------------------------------------------------------------------------

/** `#rgb` / `#rrggbb` / `rgb()` / `rgba()` -> `[r, g, b]`, or `null`. */
export function parseColor(input) {
  const text = String(input ?? '').trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(text)
  if (hex !== null) {
    const digits = hex[1].length === 3
      ? hex[1].split('').map((digit) => digit + digit).join('')
      : hex[1]
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16))
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/u.exec(text)
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

function channelLuminance(value) {
  const channel = value / 255
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance. Throws on an unparseable colour, never guesses. */
export function relativeLuminance(color) {
  const rgb = parseColor(color)
  if (rgb === null) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT,
      `无法解析颜色 "${String(color)}"：只支持 #rgb / #rrggbb / rgb() / rgba()`)
  }
  const [r, g, b] = rgb.map(channelLuminance)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, rounded to 2 decimals so it is readable and pinnable. */
export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100
}

/** The WCAG level a ratio reaches. `large` applies the 3:1 rule for large text. */
export function contrastLevel(ratio, options = {}) {
  const value = Number(ratio)
  if (!Number.isFinite(value)) return 'unknown'
  if (value >= 4.5) return 'AA'
  if (value >= (options.large === true ? 4.5 : 3)) return 'AA-large'
  return 'fail'
}

// ---------------------------------------------------------------------------

const unanchored = (tier, detail, extra = {}) => ({
  status: 'unanchored',
  tier,
  path: null,
  start: null,
  end: null,
  token: null,
  detail,
  ...extra,
})

const anchored = (path, start, end, tier, detail, token) => ({
  status: 'anchored',
  tier,
  path,
  start,
  end,
  token,
  detail,
})

const toDocuments = (subject) => {
  const raw = subject?.documents
  if (!Array.isArray(raw)) return []
  const documents = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path : ''
    const content = typeof entry.content === 'string'
      ? entry.content
      : (typeof entry.text === 'string' ? entry.text : '')
    if (path === '') continue
    documents.push({ path, content })
  }
  return documents
}

const toLayers = (subject) => (Array.isArray(subject?.layers) ? subject.layers : null)

/**
 * Rebuild the layer/token tables from the P0 candidate set — the (b)-family
 * convention documented at the top of this file.
 *
 * Each admitted candidate is one hardcoded `(layer, property)` and carries that
 * locator plus the token `source.js` resolved for it (`meta.tokenName` /
 * `tokenGroup` / `tokenValue`). Reading it back is not a shortcut: the rebuilt
 * tables are handed to exactly the same checks as declared ones, so a claim
 * outside the candidate locator space is still refused.
 *
 * Returns `null` when the array establishes neither half, so the caller can tell
 * "nothing usable was offered" (=> `no-documents`) apart from "a candidate set
 * was offered and the claim is not in it" (=> `no-match`, decided below).
 */
export function rebuildFromCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const byLayer = new Map()
  const tokens = {}
  let properties = 0

  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    const locator = candidate.locator !== null && typeof candidate.locator === 'object' ? candidate.locator : {}
    const meta = candidate.meta !== null && typeof candidate.meta === 'object' ? candidate.meta : {}
    const layerId = typeof locator.layerId === 'string' && locator.layerId !== ''
      ? locator.layerId
      : (typeof meta.layerId === 'string' && meta.layerId !== '' ? meta.layerId : null)
    const prop = typeof locator.prop === 'string' && locator.prop !== ''
      ? locator.prop
      : (typeof meta.prop === 'string' && meta.prop !== '' ? meta.prop : null)
    // A candidate with no (layer, property) locator is not part of this domain's
    // space; it contributes nothing and is not treated as a wildcard.
    if (layerId === null || prop === null) continue

    if (!byLayer.has(layerId)) {
      byLayer.set(layerId, {
        id: layerId,
        name: meta.layerName ?? null,
        type: meta.layerType ?? null,
        component: meta.component ?? null,
        props: {},
        tokenRefs: {},
      })
    }
    const layer = byLayer.get(layerId)
    if (!Object.hasOwn(layer.props, prop)) {
      layer.props[prop] = meta.value === undefined ? null : String(meta.value)
      properties += 1
    }

    const tokenName = typeof locator.tokenName === 'string' && locator.tokenName !== ''
      ? locator.tokenName
      : (typeof meta.tokenName === 'string' && meta.tokenName !== '' ? meta.tokenName : null)
    if (tokenName !== null) {
      const group = typeof meta.tokenGroup === 'string' && meta.tokenGroup !== '' ? meta.tokenGroup : 'token'
      if (!Object.hasOwn(tokens, group)) tokens[group] = {}
      if (!Object.hasOwn(tokens[group], tokenName)) {
        tokens[group][tokenName] = { value: meta.tokenValue === undefined ? null : String(meta.tokenValue) }
      }
    }
  }

  // Both halves are required by this verifier; a candidate set that establishes
  // only one of them has not rebuilt the structure.
  if (properties === 0 || Object.keys(tokens).length === 0) return null
  return { layers: [...byLayer.values()], tokens }
}

/** Is `name` a key in any group of the token table? */
export function tokenExists(tokens, name) {
  if (tokens === null || typeof tokens !== 'object') return false
  for (const members of Object.values(tokens)) {
    if (members === null || typeof members !== 'object') continue
    if (Object.hasOwn(members, name)) return true
  }
  return false
}

const structureLabel = (source) => (source === 'candidates'
  ? '结构来源：P0 候选集重建（locator 空间）'
  : '结构来源：调用方提供的图层/token 表')

/**
 * Verify one layer-and-token claim.
 *
 * @param {{kind?:string,path?:string,locator?:{layerId?:string,prop?:string,tokenName?:string,startLine?:number},excerpt?:string}} claim
 * @param {{path?:string,content?:string,documents?:Array<{path:string,content:string}>,layers?:Array<object>,tokens?:object}} subject
 * @returns {object} an AnchorVerdict
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

  const locator = claim.locator ?? {}
  const layerId = typeof locator.layerId === 'string' && locator.layerId.trim() !== '' ? locator.layerId.trim() : null
  const prop = typeof locator.prop === 'string' && locator.prop.trim() !== '' ? locator.prop.trim() : null
  const tokenName = typeof locator.tokenName === 'string' && locator.tokenName.trim() !== '' ? locator.tokenName.trim() : null

  const needle = normalizeExcerpt(claim.excerpt ?? '')
  if (needle.length === 0) {
    return unanchored('empty-excerpt', '抄写的原文规范化后为空 —— 没有可核验的证据，不得据以出结论')
  }

  const documents = toDocuments(subject)
  // Declared tables first (they are the authoritative design input); otherwise
  // rebuild the same structure from the P0 candidate set. See the convention at
  // the top of this file.
  const declaredLayers = toLayers(subject)
  const declaredTokens = subject?.tokens !== null && typeof subject?.tokens === 'object' ? subject.tokens : null
  const declaredStructure = declaredLayers !== null && declaredTokens !== null
  const rebuilt = declaredStructure ? null : rebuildFromCandidates(subject?.candidates)
  const structureSource = declaredStructure ? 'subject' : (rebuilt === null ? 'none' : 'candidates')
  const layers = declaredStructure ? declaredLayers : (rebuilt?.layers ?? null)
  const tokens = declaredStructure ? declaredTokens : (rebuilt?.tokens ?? null)
  const subjectContent = typeof subject?.content === 'string' ? subject.content : null

  if (layers === null || tokens === null) {
    return unanchored('no-documents',
      `图层侧与 token 侧必须同时提供（或能从 P0 候选集重建）才能重算这个锚点`
      + `（图层表 ${layers === null ? '缺失' : '已提供'}，token 表 ${tokens === null ? '缺失' : '已提供'}）`)
  }

  if (layerId === null || prop === null || tokenName === null) {
    return unanchored('no-match',
      '图层侧锚点不完整：必须同时给出 layerId、prop 与 tokenName。缺任何一项都无法证明「这个图层把这个值硬编码了，而它本应引用这个 token」')
  }

  const layer = layers.find((entry) => entry !== null && typeof entry === 'object' && entry.id === layerId)
  if (layer === undefined) {
    return unanchored('no-match', `图层表里没有 "${layerId}" —— 图层侧锚点无法重算，拒绝猜测最接近的图层`)
  }
  const props = layer.props !== null && typeof layer.props === 'object' ? layer.props : {}
  if (!Object.hasOwn(props, prop)) {
    return unanchored('no-match', `图层 "${layerId}" 没有属性 "${prop}" —— 属性侧锚点不成立`)
  }
  const declaredRef = layer.tokenRefs !== null && typeof layer.tokenRefs === 'object' ? layer.tokenRefs[prop] : undefined
  if (typeof declaredRef === 'string' && declaredRef.trim() !== '') {
    return unanchored('no-match',
      `图层 "${layerId}" 的属性 "${prop}" 已经声明引用 token "${declaredRef}" —— 「硬编码值」这个论断与图层属性表正面矛盾，拒绝采纳`)
  }
  if (!tokenExists(tokens, tokenName)) {
    return unanchored('no-match',
      `token 表里没有名为 "${tokenName}" 的 token —— 无法在 token 表上重算这条结论，拒绝采信一个不存在的 token`)
  }

  const preferred = typeof subject?.path === 'string' && subject.path !== '' ? subject.path : claim.path
  const named = subjectContent !== null
    ? { path: preferred, content: subjectContent }
    : documents.find((document) => document.path === preferred) ?? null

  if (named !== null) {
    const declared = locator.startLine
    if (Number.isInteger(declared) && declared >= 1) {
      if (matchesAt(named.content, needle, declared)) {
        return anchored(named.path, declared, declared + needle.length - 1, 'declared-locator',
          `第 ${declared} 行确认无误（共 ${lineCount(named.content)} 行）；图层 ${layerId}.${prop} 与 token "${tokenName}" 均已确认；${structureLabel(structureSource)}`, tokenName)
      }
      return unanchored('locator-mismatch',
        `按声明取 ${named.path}:${declared} 起的 ${needle.length} 行与抄写原文不符 —— 行号与原文矛盾，拒绝猜测，请重抄该行原文`)
    }
    const hits = allMatches(named.content, needle)
    if (hits.length === 1) {
      return anchored(named.path, hits[0].start, hits[0].end, 'recomputed-unique',
        `在 ${named.path} 唯一命中（第 ${hits[0].start}-${hits[0].end} 行），未采信模型行号；图层 ${layerId}.${prop} 与 token "${tokenName}" 均已确认；${structureLabel(structureSource)}`, tokenName)
    }
    if (hits.length === 0) {
      return unanchored('no-match', `抄写原文在 ${named.path} 中逐字未命中；若它确实在别处，需要跨文件唯一命中才能搬迁`)
    }
    return unanchored('relocation-ambiguous',
      `抄写原文在 ${named.path} 内出现 ${hits.length} 次，位置不唯一 —— 拒绝猜测`,
      { ambiguousIn: hits.map((hit) => `${named.path}:${hit.start}`) })
  }

  const others = documents.filter((document) => document.path !== preferred)
  const hits = []
  for (const document of others) {
    for (const hit of allMatches(document.content, needle)) {
      hits.push({ path: document.path, start: hit.start, end: hit.end })
    }
  }
  if (hits.length === 1) {
    const only = hits[0]
    return anchored(only.path, only.start, only.end, 'relocated-unique',
      `声明的 "${preferred}" 不在可比对文档中；原文在 "${only.path}" 跨文件唯一命中，发现已搬迁；图层 ${layerId}.${prop} 与 token "${tokenName}" 均已确认；${structureLabel(structureSource)}`, tokenName)
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
  describe: '图层存在 + 属性存在且未声明 tokenRef + token 名在 token 表里存在 + 逐字滑窗重算行号。任一项不成立即判未锚定。',
  verify,
})

export { allMatches, matchesAt }
