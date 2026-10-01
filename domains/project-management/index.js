/**
 * project-management — domain package v2 (D family, 关系型).
 *
 * WHY THIS DIRECTORY EXISTS
 * -------------------------
 * `lib/domains.js` still holds the nineteen v1 packs, and this is the same
 * `project-management` domain expressed as the v2 package the contract describes:
 * a candidate source, an anchor verifier, bounded evidence tools, two independent
 * prompt roles, a real rule library and fixtures. When the loader discovers
 * `domains/project-management/`, this pack REPLACES the v1 entry of the same id —
 * that replacement is the migration path, and it is why the v1 file is untouched.
 *
 * WHAT A D DOMAIN'S PRODUCT IS
 * ----------------------------
 * Not "something is wrong at this location" but "the relationship between these
 * two things is wrong". A single task in this pack can be flawless — clear title,
 * one owner, a sensible estimate — and the plan it lives in can still be broken by
 * a cycle or an orphan. So `anchor.js` verifies ID PAIRS, not text, and
 * `evidence.js` answers questions about the graph rather than about a file.
 *
 * THE PROPERTY THAT MAKES THE ANCHOR A HARD CONSTRAINT
 * ----------------------------------------------------
 * `anchor.verify` is `engine-recomputable`: given the plan, the engine re-derives
 * whether the claimed edge, cycle or orphan position is real. A model cannot get a
 * finding accepted by describing a plausible dependency in fluent prose. The three
 * refusals that make that true — a reversed edge, an unclosed cycle, a shared id —
 * are implemented in `anchor.js` and exercised by `test.mjs` against the fixtures
 * that contain them.
 *
 * THE FIVE EXTENSION POINTS ARE NOT INLINE HERE
 * ---------------------------------------------
 * `candidateSource`, `anchorVerifier`, `evidenceTools`, `reviewPrompts` and
 * `ruleLibrary` are all assembled by `lib/domain-loader.js` from the sibling files
 * (`source.js`, `anchor.js`, `evidence.js`, `prompts.js`, `rules/*.md`). This file
 * declares only what the pack ALONE knows. That is what keeps a domain owner's
 * edits inside their own directory.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` is 26 agent-drafted rule documents. Every one carries
 * `needs-expert-review: true`, `RULE_PROVENANCE.expertValidated` stays `false`, and
 * the prompt text says so to the model. This is a draft library with a working
 * engine around it — NOT an expert-validated planning standard. `lib/domains.js`
 * v1 shipped four seed rules for this domain; 26 hand-written drafts still are not
 * an expert library. The difference is that the gap is now visible instead of
 * implicit.
 *
 * The `bundleKey.resolve` below is the domain's own grouping semantics, and it is
 * the second thing this migration had to get right: the v1 pack declared the
 * private strategy name `'workstream'`, which is not one of the four the contract
 * knows. Declaring `{ strategy: 'path' }` instead would have been a lie — it puts
 * every candidate in its own bundle and quietly deletes P2 for this domain. See the
 * comment on `workstreamKey`.
 */

import { directoryOf, slash } from '../_lib/graph.js'

/**
 * The plan's natural grouping is the WORKSTREAM, not the file.
 *
 * Two reasons, and the second is the one that matters:
 *
 *   1. Cost. A bounded pass should hold one stream's tasks and their edges, so the
 *      reviewer can see a whole dependency chain at once. Splitting `plan.json`
 *      per file would put every edge of every stream in one bundle, which is both
 *      larger and less coherent.
 *
 *   2. Correctness. This domain's defects are relations. A cycle is only visible
 *      if all of its edges are adjudicated TOGETHER. Grouping by path would spread
 *      the three edges of a three-task cycle across one bundle (they share a
 *      document) — but grouping by path is still wrong for the common case where
 *      the plan is split per stream, because then a cross-stream cycle is split
 *      across bundles and can never be seen at all. Grouping by workstream keeps
 *      each stream's internal structure whole.
 *
 * Falls back to the document's directory when a candidate carries no workstream
 * metadata — a caller who hand-feeds `candidates` without `meta.workstream` still
 * gets a deterministic, non-degenerate grouping.
 */
export function workstreamKey(candidate) {
  const workstream = candidate?.meta?.workstream
  if (typeof workstream === 'string' && workstream !== '') return `ws/${workstream}`
  const documentPath = candidate?.meta?.graphPath
  if (typeof documentPath === 'string' && documentPath !== '') return `doc/${slash(documentPath)}`
  return `dir/${directoryOf(candidate?.path, 2)}`
}

/**
 * The pack's own exclude list. Deliberately SHORT: `DEFAULT_EXCLUDE_PATTERNS` in
 * `lib/engine.js` already covers `node_modules`, `vendor`, `dist`, `build` and
 * `target` as `default-path`. Restating them here would change which predicate
 * fires — and therefore the reason a report shows — without changing the outcome,
 * which makes the reason worse for no gain.
 */
const DOC_GATE = {
  exclude: ['**/node_modules/**', '**/.git/**', '**/archived/**'],
}

/**
 * The document types this domain reads. `.json`/`.yaml`/`.md` are the three a
 * tracker export actually arrives as; `.txt` is deliberately absent so the
 * `all-gated-out` fixture can pin the extension predicate.
 *
 * EXPORTED, and exported for a reason that is not convenience. This list has a
 * PARTNER it must intersect with: the `match` globs on the rule documents in
 * `rules/`. The gate decides which candidates reach review; the rules decide what
 * the reviewer is told about them. Both halves can be individually correct while
 * their INTERSECTION is empty — the gate admits a `.yaml` plan and the rule
 * loader injects nothing, so the plan is reviewed with an empty rule set and not
 * one assertion notices, because every existing assertion was written about
 * `.json`. That is what happened here: entry point 9 of "the test describes what
 * I thought happens, not what must happen", and the subtlest of them because no
 * single file is wrong.
 *
 * So this is exported so `test.mjs` can compute the intersection from the pack's
 * OWN declaration rather than from a hand-copied list — a copy would drift the
 * moment someone adds an extension. Widening the rule globs (rather than
 * narrowing this list) was the fix, and the reason is that this list is the
 * honest one: the caller hands the domain an already-parsed payload, so any of
 * these serializations is really readable, and a rule about task graphs is about
 * the GRAPH, not about the syntax it arrived in.
 */
export const GATE_EXTENSIONS = ['.json', '.yaml', '.yml', '.md', '.csv']

/**
 * NOTE: `candidateSource` is deliberately NOT declared here, and there is not even
 * a named re-export of it.
 *
 * `lib/domain-loader.js` looks for a named `candidateSource` on the module
 * namespace and takes it AS IS when present, falling back to `source.js` only when
 * it is absent. A named export whose value is the *descriptor* rather than the
 * `defineCandidateSource(...)` object would therefore shadow the real sibling and
 * fail `validateCandidateSource` with "enumerate must be a function" — which is
 * exactly what happened on the first run of this domain's test. The descriptor
 * belongs in the pack (`candidateSet`), and the implementation belongs in
 * `source.js`. Nothing here names `candidateSource`.
 */

/**
 * Named so the domain's own `test.mjs` can call the resolver DIRECTLY and assert
 * the grouping property (`ws/cart` holds more than one candidate) rather than
 * asserting `plan.bundleKey.applied` and hoping. `applied: true` is satisfiable by
 * a resolver that returns a unique key per candidate — i.e. by P2 not being done.
 */
export const bundleKey = {
  strategy: 'workstream',
  resolve: workstreamKey,
  description: '按工作流（task.team ?? task.workstream ?? 文档目录）分捆：一条依赖链上的任务与边必须落在同一捆，否则跨任务的环无法被看见。',
}

export default {
  contractVersion: 2,

  id: 'project-management',
  title: '项目管理',
  category: 'D',
  keywords: ['project', 'task', 'schedule', 'dependency', 'risk', 'milestone', 'workstream'],
  summary: '**关系型**：产物是一致性本身。锚点是「任务 ID + 依赖边」，跑在锚点链建出的图上；环、孤儿、未登记的依赖目标与失效链接都在图上重算，不靠文字描述。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // `precision-first` and `fact-checker` must agree: a planning claim the graph
  // cannot confirm is a claim the plan gets blamed for. `criticismKindConsistent`
  // checks exactly this pairing at pack-validation time.
  lossOrientation: 'precision-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'task-graph-edges',
    inputFormat: 'task-graph',
    bounded: true,
    description: '任务图上每条依赖边一个候选，每个任务/风险/里程碑一个节点候选。未知依赖目标不静默丢弃，标为 unknownTarget 交由评审判定。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: GATE_EXTENSIONS,
  },

  // --- P2 ------------------------------------------------------------------
  // The v1 pack declared the private string 'workstream', which is not one of the
  // four strategies the contract knows and would be rejected by the v2 gate. The
  // resolver below implements the SAME semantic grouping the v1 name promised,
  // rather than degrading to `{ strategy: 'path' }` (which would be one bundle per
  // candidate, i.e. P2 not done).
  //
  // The object is REFERENCED, not restated, so `test.mjs` can import the same
  // `bundleKey` and assert against the resolver that ships.
  bundleKey,

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'task-and-edge',
    verify: 'engine-recomputable',
    description: '锚点是「任务 ID + 依赖边两端」。引擎在任务图上重算：该有向边是否存在、它的方向是否与声明一致、跨节点回路是否唯一闭合、该节点是否真的没有上下游。ID 冲突、方向相反、环未闭合一律判未锚定并降级 —— 绝不猜测。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'fact-checker',
    description: '独立一轮只做事实核查：声明的边在图上是否存在、方向是否一致、该边是否证明结论。只删除图能证伪的评论，不补充新发现。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This
  // stays as the v1-shaped fallback the executor falls back to when a prompt
  // function throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是项目管理评审者，评审的是计划图的一致性与完整性，不是计划的方向是否正确。',
    instruction: '每条发现给出任务 ID 与依赖边的两端，并声明 claim kind（task-edge / cycle-path / orphan-task）。',
  },
}
