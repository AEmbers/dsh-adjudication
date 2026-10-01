/**
 * backend-engineering — domain package v2 (category B, 构建型).
 *
 * WHAT IS SHARED WITH `code-review` AND WHAT IS NOT
 * -------------------------------------------------
 * Shared (by reference, not by copy):
 *   • the candidate set: one per (file, hunk), from code-review's parser
 *   • the anchor verifier: `anchor.js` re-exports code-review's, object-identical
 *   • the three bounded diff tools: code-review's, reused by function identity
 *   • the P2 grouping口径: `{ strategy: 'directory', depth: 1 }`
 *
 * Own:
 *   • the service boundary (`serviceMap` -> `candidate.meta.service`)
 *   • the review ORDER (interface compatibility -> transactions -> backpressure
 *     -> observability) and the rule library that encodes it
 *   • one evidence tool, `interface_delta`, that answers the first question a
 *     backend reviewer asks about any diff
 *
 * WHY THE REUSE MATTERS AND IS ASSERTED
 * -------------------------------------
 * A second diff parser or a second line matcher would look correct in review and
 * drift silently the first time one side was fixed — and the anchor's tolerance
 * is exactly the thing that must not differ between two domains claiming the
 * same anchor kind. `test.mjs` asserts object/function identity, so a local
 * "small improvement" fails the domain's own test.
 *
 * HONESTY: `rules/*.md` is agent-drafted, every document carries
 * `needs-expert-review: true`, and it is NOT an expert-validated backend
 * standard.
 */

const DOC_GATE = {
  // `**/generated/**` is declared by the pack itself, not only by the fixture:
  // the all-gated-out boundary must hold under the gate THIS DOMAIN ships.
  // A fixture-supplied pattern would prove the engine honours options.exclude,
  // not that the domain excludes generated code by default.
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**'],
}

export default {
  contractVersion: 2,

  id: 'backend-engineering',
  title: '后端工程',
  category: 'B',
  keywords: ['backend', 'server', 'api', 'database', 'service', 'microservice'],
  summary: '服务端实现。**构建型**：复用代码评审的 diff 解析、锚点与取证工具，另加服务边界与服务端专属规则（接口兼容、事务、背压、可观测性）。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'diff-hunks',
    inputFormat: 'unified-diff',
    bounded: true,
    description: '与代码评审同源：变更集的 (文件, hunk)，复用其解析与 hunk 窗口，额外挂上 serviceMap 归属。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: [
      '.go', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.java', '.kt', '.cs',
      '.rb', '.php', '.sql', '.proto', '.yaml', '.yml', '.sh',
    ],
  },

  // --- P2 ------------------------------------------------------------------
  // Same口径 as code-review on purpose: the two domains serve the same diff, so
  // "one bounded pass per top-level directory" must not mean two different
  // things. Depth 1 groups services/billing/{handler,store}.go into one bundle.
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
    description: '只删除 diff 能证明为错的评论；接口变更类发现额外要求指出会失败的具体调用方，否则不算证明。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是服务端评审者，只对本次变更中有证据的缺陷给出意见，优先接口兼容与失败路径。',
    instruction: '每条意见逐字引用新增行作为锚点，不要输出行号；服务边界未知时不得推断影响面。',
  },
}
