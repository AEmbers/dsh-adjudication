/**
 * ui-visual — domain package v2 (A 审定型, precision-first).
 *
 * WHAT THIS DOMAIN JUDGES
 * -----------------------
 * Design-system adherence, and nothing else. "This looks off" is not a finding;
 * "layer `btn-primary` hardcodes #2563EB while token `color.brand-primary` is
 * exactly that value, and the layer declares no tokenRef" is. Every judgement
 * this domain makes has to land on the token table or on a computed ratio.
 *
 * THE ANCHOR RECOMPUTES AGAINST THE TOKEN TABLE
 * ---------------------------------------------
 * `layer-and-token` requires THREE independent facts, all recomputed by the
 * engine rather than taken from the model: the layer exists, the property really
 * exists on it with that value, and the token name really exists in the token
 * table. A claim naming a token that does not exist is refused — that is the
 * "cannot be recomputed against the token table" refusal.
 *
 * CONTRAST IS A NUMBER, NOT AN ADJECTIVE
 * --------------------------------------
 * `anchor.js` exports `contrastRatio(fg, bg)` (WCAG 2.x relative luminance) and
 * the `contrast_ratio` evidence tool returns the same number plus its AA level.
 * A contrast rule that reads "insufficient contrast" is not checkable; 4.54
 * against the 4.5 threshold is.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` are 22 agent-drafted rule documents, every one carrying
 * `needs-expert-review: true`. No design-system owner has reviewed them, and
 * nothing here claims otherwise.
 */

const DOC_GATE = {
  // A `deprecated` component's layers are not candidates for the design system:
  // flagging token drift in something being deleted is noise. `node_modules`
  // and friends are already covered by the engine defaults.
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/deprecated/**'],
}

export default {
  contractVersion: 2,

  id: 'ui-visual',
  title: 'UI 视觉设计',
  category: 'A',
  keywords: ['ui', 'visual', 'design-system', 'token', 'accessibility', 'contrast'],
  summary: '对设计系统一致性做审定。候选是「偏离 token 的硬编码值」，锚点是「图层 ID + token 名」—— 引擎独立到 token 表里重算该 token 是否存在。对比度规则给出可复算的 WCAG 比值，不给定性描述。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // --- P6 loss policy -------------------------------------------------------
  // precision-first => fact-checker. A subjective visual opinion is not a
  // finding, and false positives are what make design-system reviews ignorable.
  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'layers-and-tokens',
    inputFormat: 'design-tokens-and-layers',
    bounded: true,
    description: '图层属性表 + design token 表。候选是「一个偏离 token 的硬编码值」—— 一个图层的一个属性，其值未引用任何既有 token。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: DOC_GATE,

  // --- P2 ------------------------------------------------------------------
  // v2 object form with an explicit resolver. Two candidates belong together
  // when they are properties of layers in the same component: the token table
  // they are checked against is looked up once for the whole component. The
  // component scope is the leading segment of `candidate.path`
  // (`<component>/<layer>/<prop>`), so the key is stable whether or not `meta`
  // reaches the resolver. `{ strategy: 'path' }` would be one bundle per
  // candidate and P2 would be decorative — deliberately not used.
  bundleKey: {
    strategy: 'component',
    resolve: (candidate) => String(candidate?.meta?.componentScope
      ?? String(candidate?.path ?? '').split('/')[0]),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'layer-and-token',
    verify: 'engine-recomputable',
    description: '三件事都由引擎重算：图层存在、属性存在、token 名在 token 表里存在；再叠加逐字抄写的原文滑窗定位。任一项不成立即判未锚定 —— 引用了不存在的 token 的评论一律拒绝。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'fact-checker',
    description: '只删除与 token 表或图层属性不符的评论；不删除审美偏好，因为本领域根本不产生审美偏好类发现。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是设计系统维护者。你的评审只基于 token 表与图层属性，不评论主观审美。',
    instruction: '每条发现必须给出图层 ID、当前值、应为的 token 名；对比度类发现必须给出计算出的比值与阈值。',
  },
}
