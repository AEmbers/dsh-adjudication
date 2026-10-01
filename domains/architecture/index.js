/**
 * architecture — domain package v2.
 *
 * MIGRATED FROM `lib/domains.js`. The v1 pack declared its candidate set,
 * anchor, criticism shape, gate and bundle key in prose; this directory is the
 * same domain with all five extension points actually implemented. The v1 entry
 * is untouched — when the loader discovers `domains/architecture/`, this pack
 * REPLACES the same-id entry, and nothing shared had to be edited.
 *
 * THE POINT OF THIS DOMAIN
 * ------------------------
 * A dependency claim is either in the graph or it is not. So its anchor is not a
 * line of text — it is an EDGE, and the engine recomputes it by walking the
 * graph. `anchor.js` therefore does real graph work (edge existence, cycle
 * reachability, layer order, ADR status), and refuses to anchor anything it
 * cannot recompute from the declared graph. A verifier that only pattern-matched
 * strings would answer a question about typography instead.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` is an agent-drafted rule library. Every document carries
 * `needs-expert-review: true`, `RULE_PROVENANCE.expertValidated` stays `false`,
 * and the prompt text tells the model so. The v1 pack shipped four seed rules;
 * this is not an expert standard either. The difference is that the gap is
 * visible instead of implicit.
 *
 * `lossOrientation` is `precision-first`, so `criticism.kind` must be
 * `fact-checker`: an architecture complaint that the graph cannot demonstrate
 * costs a maintainer a refactor. A reviewer that keeps "this looks coupled to
 * me" findings would invert the domain's whole purpose.
 */

/** The module's own file — the only field the grouping may read. */
function moduleKey(path) {
  return String(path ?? '').replace(/\\/gu, '/')
}

export default {
  contractVersion: 2,

  id: 'architecture',
  title: '架构设计',
  category: 'A',
  keywords: ['architecture', 'module', 'coupling', 'adr', 'boundary', 'dependency'],
  summary: '对架构决策与模块边界做审定。锚点是模块 ID + ADR 编号，检查的是「决策是否被遵守」。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'modules-and-decisions',
    inputFormat: 'module-graph-and-adr',
    bounded: true,
    description: '模块及其依赖边，加上已归档的架构决策记录（ADR）。候选是「一条边」与「一个 (ADR, 受影响模块)」的组合。',
  },

  // --- P1 ------------------------------------------------------------------
  // Faithful to the v1 pack, which excluded test-only modules from this domain
  // (`gateMapping: 'test-only modules -> path exclusion'`): a module that exists
  // only to serve tests is not part of the deployed architecture, so its edges
  // are not architecture findings.
  //
  // `**/.git/**`, `**/dist/**`, `**/build/**` restate `DEFAULT_EXCLUDE_PATTERNS`,
  // so the set of admitted paths is unchanged by declaring them.
  //
  // CHANGED (t23): `**/generated/**` USED TO live only in the `all-gated-out`
  // fixture, on top of the patterns above. That made the boundary claim circular —
  // the suite proved "pack ∪ fixture drains the fixture", while a boundary must
  // prove "the PACK alone drains it". Measured through the real plugin, where the
  // fixture's gate does not exist, the generated module was admitted. A generated
  // module is not a designed module, so a dependency edge into it is not an
  // architecture decision; the pattern belongs in the pack.
  gate: {
    exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/generated/**', '**/test/**', '**/tests/**', '**/*.spec.*', '**/*.test.*'],
  },

  // --- P2 ------------------------------------------------------------------
  // v1 declared the private string 'module'. The contract's v2 gate rejects a
  // string strategy that is not one of the four generic ones — and it is right
  // to. Every edge of one module lives in that module's file, so the file IS the
  // module's identity for grouping purposes, and supplying `resolve` says so
  // instead of pretending `file` means it.
  //
  // The resolver reads ONLY `path`: `index.js toCandidates()` copies a fixed
  // field set off each candidate, so anything not derivable from `path` would
  // silently vanish before the grouping ever ran.
  bundleKey: {
    strategy: 'module',
    resolve: (candidate) => moduleKey(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'module-and-adr',
    verify: 'engine-recomputable',
    description: '锚点是「模块 ID」或「ADR 编号」。声明依赖方向的发现必须能被依赖图验证：引擎重算该边是否真的在 dependsOn 里，并按发现种类核对环、层次方向、ADR 状态或决策覆盖面；图上不成立的声一律未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'fact-checker',
    description: '只保留依赖图或 ADR 归档能证明的发现；图上不成立的、或 ADR 中无此决策的，删除。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  prompt: {
    role: '你是架构评审者，评审的是决策一致性与依赖结构，不是代码风格。',
    instruction: '凡声称违反某决策，必须给出 ADR 编号；凡声称存在反向依赖，必须给出边的两端。',
  },
}
