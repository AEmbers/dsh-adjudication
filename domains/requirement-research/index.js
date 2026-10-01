/**
 * requirement-research — domain package v2 (category B, 构建型).
 *
 * This file is DATA. Five extension points are assembled from the sibling files
 * by `lib/domain-loader.js` (`source.js` / `anchor.js` / `evidence.js` /
 * `prompts.js` / `rules/*.md`), and this module deliberately declares NONE of
 * them inline — a pack that both declares and ships an implementation has two
 * sources of truth, and the domain's `test.mjs` asserts they are not duplicated.
 *
 * WHY IT IS B AND NOT A
 * ---------------------
 * The candidate set is not the requirement — it is the QUOTE. Requirements are
 * produced by `generator.js`, a constrained extractor whose every item must hang
 * on a verbatim utterance, and only then does the audit-shaped loop run. Two
 * stages, and the first one produces drafts that are re-checked rather than
 * trusted.
 *
 * RECALL-FIRST, AND WHAT THAT COSTS
 * ---------------------------------
 * Missing a real user need costs a rework cycle; an extra noise item costs a
 * reviewer's minute. So the orientation is `recall-first` and the reviewer shape
 * is `triage`: P6 separates proven from doubtful instead of deleting the
 * doubtful. `criticismKindConsistent` checks that pairing at validation time.
 *
 * HONESTY: `rules/*.md` is agent-drafted and every document carries
 * `needs-expert-review: true`. This is a draft library with a working engine
 * around it — NOT an expert-validated requirements discipline.
 */

const DOC_GATE = {
  exclude: [
    '**/.git/**',
    // Domain-specific, and it MEANS something: a retracted corpus is not
    // reviewable material. Without it the exclusion would be invisible and a
    // withdrawn study would silently re-enter the candidate set.
    '**/retracted/**',
  ],
}

export default {
  contractVersion: 2,

  id: 'requirement-research',
  title: '需求调研分析',
  category: 'B',
  keywords: ['requirement', 'research', 'interview', 'user-need', 'discovery'],
  summary: '从原始访谈/反馈中提取需求。**构建型**：受约束的抽取器先生成草案，每条必须挂回一句逐字原话，挂不上的单独列为「无来源」。**recall-first**：漏掉一条真实诉求的代价是返工。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'recall-first',

  // --- the B-family's first stage -------------------------------------------
  // Declared here (data), implemented in `generator.js` (code). The loader does
  // not assemble this one: it is not a contract extension point.
  generator: {
    kind: 'requirement-extraction',
    file: 'generator.js',
    stage: 'generate',
    anchorKind: 'verbatim-and-timestamp',
    describe: '草案 -> 逐条挂回原话锚点；挂不上的进 unsourced（不丢弃）。生成的每一件产物都带着引擎算出的锚点裁决。',
  },

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'verbatim-quotes',
    inputFormat: 'interview-corpus',
    bounded: true,
    description: '语料中的每一句用户原话。候选不是「需求」，是「原话」——需求是它的加工产物。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: DOC_GATE,

  // --- P2 ------------------------------------------------------------------
  // v2 object form with an explicit `resolve`: the v1 name `interview` is not a
  // generic strategy, and `path` would have been a lie (one bundle per
  // utterance). The real grouping is "one bundle per interview session", which
  // is exactly what a bounded pass should hold together — the same participant,
  // the same context, the same contradictions.
  bundleKey: {
    strategy: 'interview-session',
    resolve: (candidate) => candidate?.meta?.sessionId
      ?? candidate?.locator?.sessionId
      ?? String(candidate?.path ?? '').split('/')[1]
      ?? '(unknown)',
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'verbatim-and-timestamp',
    verify: 'engine-recomputable',
    description: '锚点是「逐字原话 + 场次/句号（+时间戳）」。引擎在语料里重算位置；转述、句号矛盾、跨场次歧义一律判定未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'triage',
    description: '不因证据不足删除条目：只把「语料正面不支持」的降级为存疑并标注，交由人工回访确认。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` is `prompts.js`, assembled by the loader. This stays as the
  // v1-shaped fallback the executor uses when a prompt function throws.
  prompt: {
    role: '你是需求调研分析者，只根据语料里逐字出现的原话提出需求，并逐条给出出处。',
    instruction: '每条需求必须附逐字原话与场次/句号；转述不算证据。挂不上原话的条目单独列为「无来源」。',
  },
}
