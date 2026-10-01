/**
 * algo-model — domain package v2.
 *
 * The v2 shape of the `algo-model` domain `lib/domains.js` declares as a v1 pack:
 * a candidate source, an anchor verifier, bounded evidence tools, two prompt
 * roles, a rule library and fixtures. When the loader discovers
 * `domains/algo-model/`, this pack REPLACES the v1 entry of the same id.
 *
 * WHAT WAS MISSING IN v1, CONCRETELY
 * ----------------------------------
 *   • four seed rules — a domain with four rules is a declaration, not a library;
 *   • no candidate source, so every (experiment, metric) pair had to be fed in by
 *     hand — and "one candidate per (experiment, metric)" IS this domain's whole
 *     point (逐题复核);
 *   • `anchor.verify: 'engine-recomputable'` with nothing that could recompute it;
 *   • a private `bundleKey` strategy name `bundle()` never read.
 *
 * THE FIVE EXTENSION POINTS ARE NOT INLINED HERE — `source.js`, `anchor.js`,
 * `evidence.js`, `prompts.js` and `rules/*.md` are assembled by
 * `lib/domain-loader.js`.
 *
 * HONESTY: `rules/*.md` is 23 agent-drafted rule documents, every one carrying
 * `needs-expert-review: true`. They are NOT an expert-validated standard.
 */

import { chainKeyFromPath } from './source.js'

const DOC_GATE = {
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/legacy/**'],
  // CHANGED (t33/t24): `**/legacy/**` is declared HERE, by the pack. The
  // all-gated-out fixture used to carry it in its own `gate` block — a fixture
  // supplying the pattern proves the engine honours `options.exclude`, not that
  // this domain excludes anything by default. Frozen legacy runs are kept for
  // provenance and are not review targets any more.
}

export default {
  contractVersion: 2,

  id: 'algo-model',
  title: '算法模型',
  category: 'A',
  keywords: ['algo', 'model', 'experiment', 'metric', 'baseline', 'ablation', 'training', 'evaluation'],
  summary: '对实验记录逐题（逐指标）复核：候选集是每个 (实验, 指标)，锚点先在 tracker 记录里重算「这个实验真的有这个指标、值也对得上」，再逐字定位记录卡原文。支持边界（t33 实测，测试里钉住）：六种已声明后缀（.json/.md/.csv/.yaml/.yml/.txt）在 experiments/ 子树内都能拿到该族 23 条规则；出了这棵子树只有 .json 还有 23 条（其余为 0），因为规则 glob 是 experiments 子树与通用 json 兜底 —— 这是被声明的边界，不是遗漏。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // recall-first: a missed metric regression costs more than a suspicion that is
  // reviewed and kept, so P6 only removes what evidence POSITIVELY disproves.
  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'experiment-metrics',
    inputFormat: 'experiment-record',
    bounded: true,
    description: 'tracker 导出（实验 + 指标 + baseline）。每个 (实验, 指标) 一个候选；没有 baseline 的实验与口径不一致的指标在 notes 里点名。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: ['.json', '.md', '.csv', '.yaml', '.yml', '.txt'],
  },

  // --- P2 ------------------------------------------------------------------
  // One bundle = ONE EXPERIMENT. The strategy name is private (a generic
  // `path`/`file`/`directory`/`extension` cannot express "one experiment"), so
  // the pack supplies `resolve`, as the contract requires. The key is derived
  // from the candidate PATH because the engine normalises candidates to
  // `{path, bytes, additions, deletions, binary, deleted, key}` before asking —
  // `meta` does not survive `toCandidates()`.
  bundleKey: {
    strategy: 'experiment',
    resolve: (candidate) => chainKeyFromPath(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'experiment-metric',
    verify: 'engine-recomputable',
    description: '模型抄写 `metric <名字> = <值>` 那一行，并声明实验 ID 与指标名（可带期望值/口径）。引擎先在 tracker 记录里重算这个实验真的有这个指标、值与口径是否一致（记录由 subject.experiments 或约定文档 experiments/records.json 提供），再逐字定位行号；指标不存在、值与口径不符一律未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'triage',
    description: '独立一轮只做分级筛选：核对原文是否存在、该实验是否真有这个指标、数字与口径是否对得上。只删除被证据正面否定的发现，证据不足一律标注后交人工。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是一名严谨的算法评审者，只对本次实验记录里、有证据支持的缺陷给出意见。',
    instruction: '每条意见必须先给出实验 ID 与指标名，并逐字引用记录卡里的那一行；没有基线的实验不得作为「有提升」的证据。',
  },
}
