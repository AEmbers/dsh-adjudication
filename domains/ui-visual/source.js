/**
 * ui-visual — P0 candidate source (contract v2, extension point 1).
 *
 * DOCUMENTED INPUT FORMAT: `design-tokens-and-layers`
 * ---------------------------------------------------
 *   {
 *     tokens: { <group>: { <name>: { value } } },
 *     layers: [{
 *       id, name, type,
 *       props:      { <prop>: value },
 *       tokenRefs?: { <prop>: <tokenName> },
 *       component?, archived?, imageOnly?, bytes?
 *     }]
 *   }
 *
 * ONE CANDIDATE PER (layer, property) whose value is NOT a token reference —
 * i.e. a hardcoded value sitting where a token should have been used. A layer
 * that IS fully tokenised contributes no candidate: that is the desired state,
 * and it is reported in `notes` rather than being silently invisible.
 *
 * TWO OTHER OUTCOMES ARE REPORTED, NOT SWALLOWED
 * ----------------------------------------------
 *   • `tokenRefs[prop]` naming a token the table does not contain -> `excluded`,
 *     because a broken reference is a real defect, just not a hardcoded value.
 *   • a layer with no `props` at all -> `excluded` with the reason.
 *
 * THE CANDIDATE IDENTITY
 * ----------------------
 * `candidate.path` is `<component>/<layer>/<prop>`. The leading segment is the
 * component, so grouping by it IS grouping by "the component whose properties
 * are checked against one token table" — the domain's true bundle semantics —
 * and it survives any downstream normalisation that keeps `path`. The gate still
 * globs the whole string, which is why the pack can exclude a `deprecated`
 * component by path.
 *
 * The SOURCE does not apply the gate: "P0 enumerated nothing" and "P1 removed
 * everything" must stay distinguishable in the plan.
 */

import { ERROR_CODES, contractError, defineCandidateSource } from '../../lib/contracts.js'

const byteLength = (value) => new TextEncoder().encode(String(value)).length

/** A lowercase, path-segment-safe spelling of an id. */
function slug(value, fallback) {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  return text === '' ? fallback : text
}

/** Flatten `{ group: { name: { value } } }` into a stable, ordered list. */
export function flattenTokens(tokens) {
  const flat = []
  if (tokens === null || typeof tokens !== 'object') return flat
  for (const [group, members] of Object.entries(tokens)) {
    if (members === null || typeof members !== 'object') continue
    for (const [name, spec] of Object.entries(members)) {
      const value = spec !== null && typeof spec === 'object' ? spec.value : spec
      flat.push({ group, name, value: value === undefined ? null : String(value) })
    }
  }
  return flat
}

/** Which token group a property name is checked against. `null` means "any". */
export function tokenGroupFor(prop) {
  const key = String(prop ?? '').toLowerCase()
  if (/(color|colour|background|foreground|fill|border|stroke|tint|shade)/u.test(key)) return 'color'
  if (/(spacing|gap|padding|margin|inset)/u.test(key)) return 'spacing'
  if (/radius/u.test(key)) return 'radius'
  if (/(font|text-size|size|line-height|leading|tracking)/u.test(key)) return 'font-size'
  if (/(shadow|elevation|blur)/u.test(key)) return 'shadow'
  if (/opacity/u.test(key)) return 'opacity'
  return null
}

/**
 * The token a hardcoded value SHOULD have used: the first token whose value is
 * identical, preferring the group the property's role implies. `null` when no
 * token carries that value — which does not make the property a non-candidate,
 * it makes it a candidate with no obvious replacement.
 */
export function resolveTokenFor(prop, value, flatTokens) {
  const wanted = String(value ?? '')
  const group = tokenGroupFor(prop)
  const inGroup = group === null ? [] : flatTokens.filter((token) => token.group === group && token.value === wanted)
  if (inGroup.length > 0) return inGroup[0]
  return flatTokens.find((token) => token.value === wanted) ?? null
}

/** Render the material a bounded reviewer would see for one (layer, prop). */
export function propText(layer, prop, value, token, maxLines) {
  const lines = [
    `图层 ${String(layer?.id ?? '(无 id)')}「${String(layer?.name ?? '(无名称)')}」类型 ${String(layer?.type ?? '未分类')}`,
    `组件 ${String(layer?.component ?? '(未归类)')}`,
    `属性 ${String(prop)} = ${String(value)}`,
    '',
    '当前声明：',
    `  tokenRefs[${String(prop)}] = ${layer?.tokenRefs?.[prop] === undefined ? '(未声明 —— 这是一个硬编码值)' : String(layer.tokenRefs[prop])}`,
    '',
    'token 表对照：',
    token === null
      ? '  （token 表里没有任何 token 的值等于当前值 —— 需要新增或替换，而不是「就近取一个」）'
      : `  ${token.group}.${token.name} = ${token.value}`,
  ]
  if (!(Number(maxLines) > 0) || lines.length <= Number(maxLines)) return { text: lines.join('\n'), clipped: false }
  return { text: lines.slice(0, Number(maxLines)).join('\n'), clipped: true }
}

/**
 * The domain's documented-input -> candidate-set function.
 *
 * `context` is what the engine hands every source: `{ maxCandidates,
 * maxExcerptLines, include, exclude, extensions }`.
 */
export function enumerate(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, 'design-tokens-and-layers 输入必须是对象 { tokens, layers }')
  }
  if (input.tokens !== undefined
    && (input.tokens === null || typeof input.tokens !== 'object' || Array.isArray(input.tokens))) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`tokens` 必须是对象 { group: { name: { value } } }（可省略）')
  }
  if (input.layers !== undefined && !Array.isArray(input.layers)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`layers` 必须是数组（可省略）')
  }

  const maxCandidates = Number(context.maxCandidates) > 0 ? Number(context.maxCandidates) : 400
  const maxExcerptLines = Number(context.maxExcerptLines) > 0 ? Number(context.maxExcerptLines) : 500

  const flatTokens = flattenTokens(input.tokens)
  const tokenNames = new Set(flatTokens.map((token) => token.name))
  const layers = Array.isArray(input.layers) ? input.layers : []

  const candidates = []
  const excluded = []
  const notes = []
  const seenIds = new Set()
  let truncated = false

  const push = (candidate) => {
    if (candidates.length >= maxCandidates) { truncated = true; return false }
    if (seenIds.has(candidate.id)) {
      notes.push(`重复的候选 id "${candidate.id}" 已被跳过（图层 id 或属性名不唯一？）`)
      return false
    }
    seenIds.add(candidate.id)
    candidates.push(candidate)
    return true
  }

  for (const [index, layer] of layers.entries()) {
    if (layer === null || typeof layer !== 'object') {
      excluded.push({ id: `layer#${index + 1}`, reason: '图层条目不是对象' })
      continue
    }
    const layerId = String(layer.id ?? '').trim()
    if (layerId === '') {
      excluded.push({ id: `layer#${index + 1}`, reason: '图层缺少 id —— 图层侧锚点将无法重算' })
      continue
    }
    const props = layer.props
    if (props === null || typeof props !== 'object') {
      excluded.push({ id: layerId, reason: '图层缺少 props 对象 —— 没有任何可对照 token 表的属性' })
      continue
    }

    const componentScope = slug(layer.component, 'unassigned')
    const layerScope = slug(layerId, 'layer')
    const refs = layer.tokenRefs !== null && typeof layer.tokenRefs === 'object' ? layer.tokenRefs : {}
    let contributed = 0
    let brokenRefs = 0

    for (const [prop, rawValue] of Object.entries(props)) {
      const value = rawValue === undefined ? null : String(rawValue)
      const ref = typeof refs[prop] === 'string' && refs[prop].trim() !== '' ? refs[prop].trim() : null

      if (ref !== null) {
        if (!tokenNames.has(ref)) {
          brokenRefs += 1
          excluded.push({
            id: `${layerId}.${prop}`,
            reason: `属性 "${prop}" 引用了 token 表里不存在的 token "${ref}" —— 这是坏引用，不是硬编码值`,
          })
        }
        // A correctly referenced property is the DESIRED state: not a candidate.
        continue
      }

      const token = resolveTokenFor(prop, value, flatTokens)
      const rendered = propText(layer, prop, value, token, maxExcerptLines)
      if (rendered.clipped) {
        truncated = true
        notes.push(`${layerId}.${prop} 的候选正文超过 maxExcerptLines ${maxExcerptLines}，已截断`)
      }
      const declaredBytes = Number(layer.bytes)
      if (push({
        id: `${layerId}.${prop}`,
        path: `${componentScope}/${layerScope}/${slug(prop, 'prop')}`,
        locator: { layerId, prop, ...(token === null ? {} : { tokenName: token.name }) },
        text: rendered.text,
        bytes: Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : byteLength(rendered.text),
        ...(layer.imageOnly === true ? { binary: true } : {}),
        ...(layer.archived === true ? { deleted: true } : {}),
        meta: {
          layerId,
          layerName: layer.name ?? null,
          layerType: layer.type ?? null,
          component: layer.component ?? null,
          componentScope,
          prop,
          value,
          tokenName: token?.name ?? null,
          tokenValue: token?.value ?? null,
          tokenGroup: token?.group ?? null,
        },
      })) contributed += 1
    }

    if (contributed === 0 && brokenRefs === 0) {
      notes.push(`图层 ${layerId} 的属性全部引用了既有 token —— 这是期望状态，不产生候选`)
    }
  }

  return { candidates, excluded, notes, bounded: true, truncated }
}

export default defineCandidateSource({
  kind: 'layers-and-tokens',
  inputFormat: 'design-tokens-and-layers',
  bounded: true,
  describe: '图层属性表 + design token 表 -> 每个未引用 token 的硬编码属性一个候选；坏 token 引用与无可审属性的图层进 excluded。',
  enumerate,
})
