/**
 * ux-review — domain package v2 (A 审定型, precision-first).
 *
 * WHAT THIS DOMAIN JUDGES
 * -----------------------
 * The completeness and recoverability of an interaction flow — not visual taste.
 * The unit of work is "ONE STEP ON ONE BRANCH", because a step is only correct
 * or incorrect relative to the branch it is reached through: the happy path may
 * handle it, the error path may not, and the interrupt path may not exist at all.
 * That is also why the bundle key is the branch: candidates that share a branch
 * share its preconditions, so they are cheap to judge together.
 *
 * THE ANCHOR IS TWO-SIDED
 * -----------------------
 * `flow-step-and-node`: the branch/step binding must exist in the flow (a step
 * named by a branch that does not list it is not part of that branch), AND the
 * quoted text must re-locate in the material. A claim with only one half is
 * unanchored, never repaired.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` are 22 agent-drafted rule documents, every one carrying
 * `needs-expert-review: true`. They are a DRAFT of a usability review standard.
 * No UX researcher has reviewed them, and nothing here claims otherwise.
 */

const DOC_GATE = {
  // `exported` branches are snapshot artefacts, not interaction flows. Excluding
  // them by path is the domain's own narrowing; `node_modules`/`dist`/lockfiles
  // are already covered by the engine defaults and are deliberately NOT restated.
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/exported/**'],
}

export default {
  contractVersion: 2,

  id: 'ux-review',
  title: 'UX 交互设计',
  category: 'A',
  keywords: ['ux', 'interaction', 'flow', 'usability', 'figma', 'onboarding', 'branch'],
  summary: '对交互流程做逐分支逐步骤的可用性审定。锚点是「分支 + 步骤」的绑定 + 设计稿节点，不是主观感受；引擎独立重算绑定，模型只抄写原文。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // --- P6 loss policy -------------------------------------------------------
  // precision-first => fact-checker. A usability opinion that cannot be tied to a
  // step and a consequence is noise, and noise is expensive here.
  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'flow-steps',
    inputFormat: 'flow-spec',
    bounded: true,
    description: '流程图（步骤与分支）+ 设计稿节点表。候选是「一个分支上的一个步骤」—— 分支本身就是候选集的一部分（正常/错误/中断/回退/空态/首用）。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: DOC_GATE,

  // --- P2 ------------------------------------------------------------------
  // v2 object form with an explicit resolver. Two candidates belong together
  // when they are reached through the same branch of the same flow: that is the
  // precondition set a bounded pass has to hold at once. The branch scope is the
  // leading two segments of `candidate.path` (`<flow>/<branch>/<step>`), so the
  // key is stable whether or not `meta` reaches the resolver.
  // `{ strategy: 'path' }` would be one bundle per candidate and P2 would be
  // decorative — deliberately not used.
  bundleKey: {
    strategy: 'flow-branch',
    resolve: (candidate) => String(candidate?.meta?.branchKey
      ?? String(candidate?.path ?? '').split('/').slice(0, 2).join('/')),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'flow-step-and-node',
    verify: 'engine-recomputable',
    description: '步骤侧：分支必须真实存在，且该分支的步骤表里必须真的有这个步骤；证据侧：模型逐字抄写的原文由引擎滑窗重算。两半缺一即判未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'fact-checker',
    description: '只删除流程里不存在的步骤、不存在的分支绑定、或原文无法支撑结论的评论；不删除「这条设计看起来不够好」。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是资深交互设计师，评审的是流程的完备性与可恢复性，不是视觉偏好。',
    instruction: '凡涉及用户感受的判断，必须落到具体分支、具体步骤与具体后果上，否则不要提出。',
  },
}
