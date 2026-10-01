/**
 * ui-visual — P7 evidence tools (contract v2, extension point 3).
 *
 * WHAT THESE ARE FOR
 * ------------------
 * A bounded design-system reviewer needs to check the token table and the layer
 * properties it is judging, and the only thing it may not have is unlimited
 * access. Each tool declares `limits`; `normaliseEvidenceLimits` clamps them to
 * the contract's hard ceilings; every result carries `{ items, truncated,
 * provenance }`.
 *
 *   resolve_token     which token carries this exact value?
 *   contrast_ratio    the WCAG ratio for a colour pair, as a NUMBER
 *   list_layer_props  what does this layer declare, and which props are refs?
 *
 * `contrast_ratio` imports `contrastRatio` from `./anchor.js` rather than
 * re-implementing it: there must be exactly ONE contrast formula in this domain,
 * or the tool and the anchor could disagree about whether a pair passes.
 *
 * All three read content the CALLER injects through `args`. They touch no
 * filesystem: this package has zero runtime imports, and an evidence tool that
 * reached for `node:fs` would break that on the first host that links the plugin
 * instead of installing it.
 */

import { ERROR_CODES, contractError, defineEvidenceToolkit } from '../../lib/contracts.js'
import { flattenTokens, resolveTokenFor } from './source.js'
import { contrastLevel, contrastRatio, parseColor, tokenExists } from './anchor.js'

const TOKENS_SCHEMA = {
  type: 'object',
  description: 'token 表：{ <group>: { <name>: { value } } }。必须由调用方注入。',
  additionalProperties: true,
}

function tokensFrom(args) {
  const raw = args?.tokens
  if (raw === null || typeof raw !== 'object') {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `tokens`：{ group: { name: { value } } }。没有 token 表就无法回答「这个值应该用哪个 token」。')
  }
  return raw
}

function layersFrom(args) {
  const raw = args?.layers
  if (!Array.isArray(raw)) {
    throw contractError(ERROR_CODES.E_INPUT_FORMAT, '缺少 `layers`：[{ id, props, tokenRefs? }]。')
  }
  return raw.filter((entry) => entry !== null && typeof entry === 'object')
}

export default defineEvidenceToolkit({
  tools: [
    {
      name: 'resolve_token',
      description: '给定一个值，返回 token 表里值与之完全相同的 token（可限定 group）。命中条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: '要查找的值（逐字比较，不是模糊匹配）' },
          group: { type: 'string', description: '限定 token 组（可省略）' },
          tokens: TOKENS_SCHEMA,
        },
        required: ['value', 'tokens'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 40, maxItems: 32, maxBytes: 32_768, maxCalls: 10 },
      execute(args) {
        const wanted = String(args?.value ?? '')
        if (wanted === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`value` 不能为空')
        const group = typeof args?.group === 'string' && args.group !== '' ? args.group : null
        const flat = flattenTokens(tokensFrom(args)).filter((token) => group === null || token.group === group)
        const matches = flat.filter((token) => token.value === wanted)
        const items = matches.slice(0, 32).map((token) => ({ group: token.group, name: token.name, value: token.value }))
        return {
          items,
          truncated: matches.length > items.length,
          provenance: `在 ${flat.length} 个 token 中按值逐字比较，命中 ${matches.length} 个${group === null ? '' : `（限定 group=${group}）`}`,
          notes: matches.length === 0
            ? ['token 表里没有任何 token 的值等于该值 —— 需要新增 token 或改值，而不是「就近取一个」']
            : [],
        }
      },
    },
    {
      name: 'contrast_ratio',
      description: '计算一对颜色的 WCAG 2.x 对比度比值（保留两位小数）与它达到的等级。比值是可复算的数字，不是定性描述；颜色无法解析时直接报错，不猜。',
      parameters: {
        type: 'object',
        properties: {
          foreground: { type: 'string', description: '前景色：#rgb / #rrggbb / rgb()' },
          background: { type: 'string', description: '背景色：#rgb / #rrggbb / rgb()' },
          largeText: { type: 'boolean', description: '按大字号标准（3:1）判定时可置 true' },
        },
        required: ['foreground', 'background'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 8, maxItems: 4, maxBytes: 8_192, maxCalls: 12 },
      execute(args) {
        const foreground = String(args?.foreground ?? '')
        const background = String(args?.background ?? '')
        if (parseColor(foreground) === null) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `无法解析前景色 "${foreground}"：只支持 #rgb / #rrggbb / rgb()`)
        }
        if (parseColor(background) === null) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT, `无法解析背景色 "${background}"：只支持 #rgb / #rrggbb / rgb()`)
        }
        const ratio = contrastRatio(foreground, background)
        const large = args?.largeText === true
        return {
          items: [{ foreground, background, ratio, level: contrastLevel(ratio, { large }), threshold: large ? 3 : 4.5 }],
          truncated: false,
          provenance: `WCAG 2.x 相对亮度公式，比值保留两位小数；阈值 ${large ? 3 : 4.5}:1`,
        }
      },
    },
    {
      name: 'list_layer_props',
      description: '列出一个图层的属性：每项是引用了 token，还是硬编码值，以及该值对应哪个 token。条数有硬上限。',
      parameters: {
        type: 'object',
        properties: {
          layerId: { type: 'string', description: '图层 id' },
          layers: { type: 'array', description: '图层表', items: { type: 'object', additionalProperties: true } },
          tokens: TOKENS_SCHEMA,
        },
        required: ['layerId', 'layers'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            truncated: { type: 'boolean' },
            provenance: { type: 'string' },
          },
        },
      },
      limits: { maxLines: 60, maxItems: 48, maxBytes: 65_536, maxCalls: 10 },
      execute(args) {
        const wanted = String(args?.layerId ?? '')
        if (wanted === '') throw contractError(ERROR_CODES.E_INPUT_FORMAT, '`layerId` 不能为空')
        const layers = layersFrom(args)
        const layer = layers.find((entry) => entry.id === wanted)
        if (layer === undefined) {
          throw contractError(ERROR_CODES.E_INPUT_FORMAT,
            `图层表里没有 "${wanted}"。可用的图层：${layers.map((entry) => String(entry.id)).join(', ') || '(空)'}`)
        }
        // `tokens` is optional for this tool: without a token table the props are
        // still listed, they simply get no `suggestedToken`.
        const tokenTable = args.tokens !== null && typeof args.tokens === 'object' ? args.tokens : {}
        const flat = flattenTokens(tokenTable)
        const refs = layer.tokenRefs !== null && typeof layer.tokenRefs === 'object' ? layer.tokenRefs : {}
        const props = layer.props !== null && typeof layer.props === 'object' ? layer.props : {}
        const items = []
        let brokenRefs = 0
        for (const [prop, rawValue] of Object.entries(props)) {
          if (items.length >= 48) break
          const value = rawValue === undefined ? null : String(rawValue)
          const ref = typeof refs[prop] === 'string' && refs[prop].trim() !== '' ? refs[prop].trim() : null
          if (ref !== null && !tokenExists(tokenTable, ref)) brokenRefs += 1
          const token = ref === null ? resolveTokenFor(prop, value, flat) : null
          items.push({
            layerId: wanted,
            prop,
            value,
            kind: ref === null ? 'hardcoded' : 'token-ref',
            tokenRef: ref,
            suggestedToken: token === null ? null : `${token.group}.${token.name}`,
          })
        }
        return {
          items,
          truncated: Object.keys(props).length > items.length,
          provenance: `图层 "${wanted}" 声明 ${Object.keys(props).length} 个属性，其中 ${items.filter((item) => item.kind === 'hardcoded').length} 个是硬编码值`,
          notes: brokenRefs > 0 ? [`⚠️ ${brokenRefs} 个属性引用了 token 表里不存在的 token（坏引用）`] : [],
        }
      },
    },
  ],
})
