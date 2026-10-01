/**
 * product-planning — domain package v2 (category B, 构建型).
 *
 * DATA ONLY. The five extension points are assembled from the sibling files by
 * `lib/domain-loader.js`; declaring one inline as well would create two sources
 * of truth, and the domain's `test.mjs` asserts they are not duplicated.
 *
 * WHY IT IS B
 * -----------
 * The candidate is an EDGE (plan ↔ requirement), and an edge alone is not a
 * plan. `generator.js` drafts plan items and refuses to emit one that does not
 * hang on a real requirement id, its verbatim title, and a metric somebody
 * declared. The audit loop then runs over the gated edges.
 *
 * PRECISION-FIRST
 * ---------------
 * An unfunded "upgrade" costs more than a missed idea: precision-first, with the
 * `fact-checker` reviewer shape P6 implies. `criticismKindConsistent` checks
 * that pairing at validation time.
 *
 * HONESTY: `rules/*.md` is agent-drafted with `needs-expert-review: true`. It is
 * a draft library with a working engine around it, NOT an expert-validated
 * planning discipline.
 */

const DOC_GATE = {
  exclude: ['**/.git/**'],
}

export default {
  contractVersion: 2,

  id: 'product-planning',
  title: '产品规划经理',
  category: 'B',
  keywords: ['product', 'planning', 'roadmap', 'priority', 'okr', 'spec'],
  summary: '把已确认的需求编排成受约束的方案。**构建型**：编排器先生成方案项，每条必须挂回需求库中真实存在的需求 ID 与逐字原文，并落在一个被声明过的指标上；挂不上的单独列为「无来源」。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'precision-first',

  // --- the B-family's first stage -------------------------------------------
  generator: {
    kind: 'plan-item-drafting',
    file: 'generator.js',
    stage: 'generate',
    anchorKind: 'requirement-and-metric',
    describe: '草案 -> 逐条挂回需求 ID + 逐字原文 + 已声明指标；挂不上的进 unsourced（范围蔓延 / 断链分开标注）。',
  },

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'requirement-to-plan-links',
    inputFormat: 'requirement-registry-and-plan',
    bounded: true,
    description: '每条需求与它被分配到的方案项之间的边。孤儿需求与孤儿方案是主要候选 —— 两侧的「没人接」都是发现。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: DOC_GATE,

  // --- P2 ------------------------------------------------------------------
  // v2 object form with an explicit resolver. v1's `release` named a grouping
  // this package never implemented; the honest grouping is one bundle per PLAN,
  // because a bounded pass should hold one plan and every requirement it claims
  // to serve together — that is where the traceability contradictions are.
  bundleKey: {
    strategy: 'plan-item',
    // Path-derived on purpose: the plugin's `toCandidates()` keeps only
    // {path, bytes, additions, deletions, binary, deleted, key}, so a resolver
    // that read `candidate.meta` would silently degrade to one bundle per
    // candidate the moment it ran through the real tool surface.
    resolve: (candidate) => {
      const segments = String(candidate?.path ?? '').split('/')
      if (segments[0] === 'plans' && segments.length > 1) return segments[1]
      if (segments[0] === 'requirements' && segments.length > 1) return `requirements/${segments[1]}`
      return String(candidate?.path ?? '(unknown)')
    },
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'requirement-and-metric',
    verify: 'engine-recomputable',
    description: '锚点是「需求 ID + 逐字需求原文 + 被声明过的指标」。引擎校验需求存在于需求库、原文逐字命中、指标由对应方案声明；缺一即未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'fact-checker',
    description: '只删除需求库中不存在的 ID、原文对不上、或指标缺基线的方案项；孤儿需求与孤儿方案不因「看起来不重要」被删。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是产品规划评审者，只认可追溯到已确认需求、且有可度量指标的方案项。',
    instruction: '每条方案项给出需求 ID 与逐字需求原文，以及指标的名称、基线、目标值、时间窗。',
  },
}
