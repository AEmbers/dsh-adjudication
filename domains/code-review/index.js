/**
 * code-review — domain package v2 (the reference domain).
 *
 * WHY THIS DIRECTORY EXISTS
 * -------------------------
 * `lib/domains.js` still holds the nineteen v1 packs, and this is the same
 * `code-review` domain expressed as the v2 package the contract describes: a
 * candidate source, an anchor verifier, bounded evidence tools, two independent
 * prompt roles, a real rule library and fixtures. When the loader discovers
 * `domains/code-review/`, this pack REPLACES the v1 entry of the same id — that
 * replacement is the migration path, and it is why the v1 file is untouched.
 *
 * It is the reference domain in two senses:
 *   • it is the only domain whose anchor (a line of a diff) is fully
 *     engine-recomputable today, so its verifier is a real implementation
 *     rather than a promise;
 *   • it is the only domain with an upstream to compare against
 *     (`open-code-review`), so its selection semantics are checkable rather
 *     than asserted. See `COMPARISON.md` next to this file.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` is 31 agent-drafted rule documents. Every one carries
 * `needs-expert-review: true`, `RULE_PROVENANCE.expertValidated` stays `false`,
 * and the prompt text says so to the model. This is a draft library with a
 * working engine around it — NOT an expert-validated review standard.
 * `lib/domains.js` v1 shipped four seed rules for this domain; that was too few
 * to call it a domain, and 31 hand-written drafts still are not an expert
 * library. The difference is that the gap is now visible instead of implicit.
 */

/**
 * The pack's own exclude list. Deliberately SHORT: `DEFAULT_EXCLUDE_PATTERNS` in
 * `lib/engine.js` already covers `node_modules`, `vendor`, `dist`, `build`,
 * `target`, lock files and minified assets as `default-path`. Restating them here
 * would change which predicate fires — and therefore the reason a report shows —
 * without changing the outcome, which makes the reason worse for no gain. The
 * first three entries are exactly such restatements.
 */
const DOC_GATE = {
  // CHANGED (t36). The fourth entry is NOT a restatement — nothing in
  // `DEFAULT_EXCLUDE_PATTERNS` matches it — and it used to be left to the
  // `all-gated-out` fixture instead of being declared here. That made the
  // reference domain's own boundary circular: the suite proved
  // "pack ∪ fixture drains the fixture", while the thing a boundary must prove is
  // "the PACK alone drains it". Measured with `docs/review-antipatterns.md` §1.4's
  // command, the real plan tool admitted exactly one candidate —
  // `generated/types.ts`, the pattern the fixture was quietly supplying.
  //
  // (The glob is written here as a line comment rather than inside the doc block
  // above because it contains the sequence that ends a block comment.)
  //
  // This is the template defect: eighteen domains copied this file's boundary
  // shape. Generated code is machine-written, so a review comment on it is not
  // actionable and the domain should refuse it by default — which means the rule
  // belongs to the pack, not to a test fixture. Same fix, same reasoning as
  // `domains/backend-engineering/index.js:37` and
  // `domains/frontend-engineering/index.js:23`.
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**'],
}

export default {
  contractVersion: 2,

  id: 'code-review',
  title: '代码评审',
  category: 'A',
  keywords: ['code', 'review', 'diff', 'pull-request', 'bug', 'refactor'],
  summary: '对变更集做有界评审，逐条锚定到 diff 行。open-code-review 的原始领域，是引擎的基准，也是 v2 契约的参照实现。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'diff-hunks',
    inputFormat: 'unified-diff',
    bounded: true,
    description: '变更集中的 (文件, hunk)，经 P1 闸门过滤。小变更短路，不调用规划模型。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: [
      '.go', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.java', '.kt', '.cs',
      '.rb', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.sql', '.sh',
      '.ps1', '.vue', '.svelte', '.yml', '.yaml', '.toml',
    ],
  },

  // --- P2 ------------------------------------------------------------------
  // The v2 object form, so the strategy is explicit rather than opted into.
  // `directory` at depth 1 groups `src/util/a.ts` and `src/b.ts` together.
  bundleKey: { strategy: 'directory', depth: 1 },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'diff-line',
    verify: 'engine-recomputable',
    description: '模型逐字抄写它想评论的新增行，引擎用滑窗在文件内容中定位并重算行号；行号与原文矛盾、或原文位置不唯一时，一律判定未锚定并降级 —— 绝不猜测。',
  },

  // --- P6 ------------------------------------------------------------------
  // `fact-checker` is the shape precision-first implies; `criticismKindConsistent`
  // checks exactly this pairing at pack-validation time.
  criticism: {
    kind: 'fact-checker',
    description: '独立一轮只做事实核查：原文是否存在、原文是否证明结论。只删除 diff 能证伪的评论，不补充新发现。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This
  // stays as the v1-shaped fallback the executor falls back to when a prompt
  // function throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是一名资深代码评审者，只对本次变更中的、有证据支持的缺陷给出意见。',
    instruction: '对每条意见，逐字引用新增行作为锚点，不要输出行号。证据不足以证明时，不要提出。',
  },
}
