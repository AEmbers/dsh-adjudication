/**
 * frontend-engineering — domain package v2 (category B, 构建型).
 *
 * WHAT IS SHARED WITH `code-review` (by reference, not by copy)
 * ------------------------------------------------------------
 *   • candidate set: one per (file, hunk), from code-review's parser
 *   • anchor verifier: `anchor.js` re-exports code-review's, object-identical
 *   • three bounded diff tools: code-review's, reused by function identity
 *   • P2 grouping口径: `{ strategy: 'directory', depth: 1 }`
 *
 * OWN: the design-tool joins (`bundleReport` -> `candidate.meta.chunkBytes`), the
 * review order (render correctness -> async races -> a11y -> bundle cost), the
 * rule library, and `render_scope`.
 *
 * HONESTY: `rules/*.md` is agent-drafted, every document carries
 * `needs-expert-review: true`. NOT an expert-validated frontend standard.
 */

const DOC_GATE = {
  // The all-gated-out boundary must hold under the gate THIS DOMAIN ships, so
  // `**/generated/**` lives here and not only in the fixture (a fixture-supplied
  // pattern would prove the engine honours options.exclude, not the domain).
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**'],
}

export default {
  contractVersion: 2,

  id: 'frontend-engineering',
  title: '前端工程',
  category: 'B',
  keywords: ['frontend', 'web', 'react', 'vue', 'css', 'browser', 'performance'],
  summary: '客户端实现。**构建型**：复用代码评审的 diff 解析、锚点与取证工具，另加渲染正确性、异步竞态、可访问性与体积成本规则。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'diff-hunks',
    inputFormat: 'unified-diff',
    bounded: true,
    description: '与代码评审同源：变更集的 (文件, hunk)，额外挂上 bundleReport 体积数据；没有数据的候选在报告里标注为未知。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less', '.html', '.json'],
  },

  // --- P2 ------------------------------------------------------------------
  // Same口径 as code-review and backend-engineering: same diff, same grouping.
  bundleKey: { strategy: 'directory', depth: 1 },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'diff-line',
    verify: 'engine-recomputable',
    description: '与代码评审**同一个**验证器（anchor.js 从 code-review 复用，非另造）：逐字抄写新增行，引擎滑窗重算；转述、行号矛盾、位置不唯一一律未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'fact-checker',
    description: '只删除 diff 能证明为错的评论；体积类发现必须有数据，未知既不当成「无影响」也不当成「有影响」。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是客户端评审者，只对本次变更中有证据的缺陷给出意见，优先渲染正确性与异步竞态。',
    instruction: '每条意见逐字引用新增行作为锚点，不要输出行号；没有体积数据时不得断言不影响首屏。',
  },
}
