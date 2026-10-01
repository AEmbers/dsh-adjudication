/**
 * data-engineering — domain package v2.
 *
 * This directory is the same `data-engineering` domain `lib/domains.js` declares
 * as a v1 pack, expressed in the v2 shape: a candidate source, an anchor
 * verifier, bounded evidence tools, two independent prompt roles, a real rule
 * library and fixtures. When the loader discovers `domains/data-engineering/`,
 * this pack REPLACES the v1 entry of the same id — that replacement is the
 * migration path, and it is why the v1 file is untouched.
 *
 * WHAT WAS MISSING IN v1, CONCRETELY
 * ----------------------------------
 *   • four seed rules — a domain with four rules is a declaration, not a library;
 *   • no candidate source, so every candidate had to be hand-fed to the planner;
 *   • `anchor.verify: 'engine-recomputable'` was a promise: there was no code
 *     that could recompute a lineage anchor at all;
 *   • `bundleKey: 'flow'`-style private strategy names that `bundle()` never read,
 *     so P2 silently degraded to one bundle per candidate.
 *
 * THE FIVE EXTENSION POINTS ARE NOT INLINED HERE. `source.js`, `anchor.js`,
 * `evidence.js`, `prompts.js` and `rules/*.md` are assembled by
 * `lib/domain-loader.js`; this file declares only what must live at the pack
 * level. That is what keeps `validateDomainPackV2` meaningful for the assembled
 * object rather than for a hand-made one.
 *
 * HONESTY: `rules/*.md` is 24 agent-drafted rule documents, every one carrying
 * `needs-expert-review: true`. They are NOT an expert-validated standard, and
 * nothing in this package claims otherwise.
 */

import { chainKeyFromPath } from './source.js'

/**
 * The pack's own exclude list. Deliberately SHORT and a subset of the engine's
 * defaults: `DEFAULT_EXCLUDE_PATTERNS` already covers `node_modules`, `vendor`,
 * `dist`, `build`, `target` and lock files as `default-path`. Restating them
 * would change which predicate fires — and therefore the reason a report shows —
 * without changing the outcome.
 */
const DOC_GATE = {
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/backfill/**'],
  // CHANGED (t33/t24): `**/backfill/**` is declared HERE, by the pack, and not by
  // the fixture that needs it. The all-gated-out fixture used to reach
  // `admitted: 0` through a `"gate": {"maxFileBytes": 200}` block of its own —
  // but the pack's gate has no `maxFileBytes` and `adjudication_plan` has no
  // `gate` input at all, so that boundary was exercising a field the product
  // does not have. A pattern supplied by a fixture would only prove that the
  // engine honours `options.exclude`; a pattern supplied by the pack proves the
  // domain excludes something by default. One-off backfill DAGs are repaired
  // through the incident process, not reviewed as part of the model tree.
}

export default {
  contractVersion: 2,

  id: 'data-engineering',
  title: '数据工程',
  category: 'A',
  keywords: ['data', 'lineage', 'etl', 'warehouse', 'sql', 'schema', 'pipeline', 'dbt'],
  summary: '对血缘图的边与字段契约做有界评审：候选集来自血缘 JSON 的边，锚点先在图上重算这条边是否存在，再在节点 SQL 里逐字定位原文。支持边界（t33 实测，测试里钉住）：规则覆盖 models/、dags/ 下的 SQL 家族（.sql/.py/.yml/.yaml）；.json/.md/.ipynb/.jinja 在 dags/ 子树内同样命中该族规则（5 条），子树外只有 1 条通用兜底规则（**/*）——这是被声明的边界，不是遗漏。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // recall-first: a missed broken pipeline costs more than a reviewed-and-kept
  // suspicion, so P6 only removes what evidence POSITIVELY disproves.
  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'lineage-edges-and-columns',
    inputFormat: 'lineage-and-schema',
    bounded: true,
    description: '编排器导出的血缘图 + 仓库 schema。每条边一个候选；每个 SQL 里出现过的产出字段一个候选。孤儿节点/孤儿表进 excluded 并说明原因。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: ['.sql', '.py', '.yml', '.yaml', '.json', '.md', '.ipynb', '.jinja'],
  },

  // --- P2 ------------------------------------------------------------------
  // The v2 object form. `lineage-chain` is NOT one of the generic strategies
  // (`path`/`file`/`directory`/`extension`) — a bundle here is "one lineage
  // chain / one table", which generic strategies cannot express — so the pack
  // supplies `resolve`, as the contract requires of a private strategy name.
  //
  // Why this is not `{ strategy: 'path' }`: grouping by path is one bundle per
  // candidate, i.e. P2 doing nothing while reporting `applied: true`. The
  // assertion in `test.mjs` proves two candidates that belong to one chain
  // really do land in one bundle.
  bundleKey: {
    strategy: 'lineage-chain',
    // Derived from the candidate's PATH, and that is not an implementation
    // detail: through `adjudication_plan` the engine normalises every candidate
    // to `{path, bytes, additions, deletions, binary, deleted, key}` — `meta`
    // does not survive `toCandidates()`. A chain read out of `meta` would
    // degrade to one-bundle-per-path in the plan while still reporting
    // `applied: true`, which is exactly the failure this migration exists to
    // avoid. So the candidate's path IS the chain's model file
    // (`models/<schema>/<table>.<ext>`, see `source.js`) and the key is the
    // TABLE read back out of it.
    resolve: (candidate) => chainKeyFromPath(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'lineage-ref',
    verify: 'engine-recomputable',
    description: '模型抄写它依据的那一行 SQL，并声明这条边（nodeId/from/to）或这个字段（table/column）。引擎先在血缘 JSON 里重算边/字段是否真的存在（血缘图由 subject.lineage 提供，或作为约定文档 lineage/graph.json 随发现一起交回），再在节点 SQL 里逐字定位行号；图里没有的边、schema 里没有的字段一律未锚定 —— 不用 SQL 文本代替图结构，绝不猜测。',
  },

  // --- P6 ------------------------------------------------------------------
  // `triage` is the shape recall-first implies; `criticismKindConsistent`
  // checks exactly this pairing at pack-validation time. It labels the reviewer
  // and selects the P6 prompt; it never decides keep/drop.
  criticism: {
    kind: 'triage',
    description: '独立一轮只做分级筛选：核对原文是否存在、边/字段是否真的在图上。只删除被证据正面否定的发现，证据不足一律标注后交人工。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This
  // stays as the v1-shaped fallback the executor falls back to when a prompt
  // function throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是一名资深数据工程师，只对本次血缘链路上的、有证据支持的缺陷给出意见。',
    instruction: '每条意见必须先说明它属于哪条边或哪张表的哪个字段，并逐字引用依据的那一行 SQL；图里没有的边不要提。',
  },
}
