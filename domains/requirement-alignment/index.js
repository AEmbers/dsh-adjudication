/**
 * requirement-alignment — domain package v2 (D family, 关系型元领域).
 *
 * WHY THIS DIRECTORY EXISTS
 * -------------------------
 * `lib/domains.js` holds the nineteen v1 packs, and this is the same
 * `requirement-alignment` domain expressed as the v2 package the contract
 * describes: a candidate source, an anchor verifier, bounded evidence tools, two
 * independent prompt roles, a real rule library and fixtures. When the loader
 * discovers `domains/requirement-alignment/`, this pack REPLACES the v1 entry of the
 * same id — that replacement is the migration path, and it is why the v1 file is
 * untouched.
 *
 * WHAT A D META-DOMAIN'S PRODUCT IS
 * ---------------------------------
 * Not "something is wrong at this location" and not even "this graph is internally
 * inconsistent" — it is **alignment**: whether a chain that starts as a user's
 * sentence and ends as a test case still holds together across four other domains.
 * Each node of the chain is owned by a different domain, and each node's `ref` is an
 * anchor id THAT DOMAIN produced.
 *
 * That is why this pack must not build a closed data structure of its own. A node's
 * identity here is `(id, type, ref)` where `ref` points out of the domain. `source.js`
 * recognises the ref shapes the sibling domains actually emit, `anchor.js` confirms
 * them against the `upstream[]` set the corpus declares, and `evidence.js` lists the
 * links whose ref is no longer produced — the STALE LINK, which only a meta-domain
 * can see.
 *
 * THE PROPERTY THAT MAKES THE ANCHOR A HARD CONSTRAINT
 * ----------------------------------------------------
 * `anchor.verify` is `engine-recomputable`: given the graph, the engine re-derives
 * whether the claimed edge, route, dangling endpoint or cross-domain ref is real. A
 * model cannot get a finding accepted by describing a plausible chain in fluent
 * prose. The refusals that make that true — a reversed edge, a differing edge kind, a
 * broken route, an ambiguous reading, a ref whose shape cannot be consumed, a stale
 * ref — are implemented in `anchor.js` and exercised by `test.mjs` against fixtures
 * that contain them.
 *
 * THE FIVE EXTENSION POINTS ARE NOT INLINE HERE
 * ---------------------------------------------
 * `candidateSource`, `anchorVerifier`, `evidenceTools`, `reviewPrompts` and
 * `ruleLibrary` are all assembled by `lib/domain-loader.js` from the sibling files.
 * This file declares only what the pack ALONE knows.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` is the agent-drafted rule library. Every document carries
 * `needs-expert-review: true`, and the prompt text says so to the model. This is a
 * draft library with a working engine around it — NOT an expert-validated
 * traceability standard. `lib/domains.js` v1 shipped four seed rules for this
 * domain; a hand-written draft library is still not an expert library, however many
 * files it happens to contain. The difference is that the gap is now visible instead
 * of implicit.
 *
 * (No rule COUNT is written here on purpose. A number inside a honesty statement rots
 * silently the first time a rule file is added — which is exactly how this comment
 * came to disagree with what `rules/` actually holds, i.e. how a reviewer found it.)
 *
 * The `bundleKey.resolve` below is the domain's own grouping semantics: the v1 pack
 * declared the private strategy name `'artifact'`, which is not one of the four the
 * contract knows. Declaring `{ strategy: 'path' }` instead would have been a lie — it
 * puts every candidate in its own bundle and quietly deletes P2 for this domain. See
 * the comment on `chainKey`.
 */

import { slash } from '../_lib/graph.js'
import { chainOf } from './source.js'

/**
 * A chain's candidates must be adjudicated TOGETHER, and that is the whole grouping
 * argument.
 *
 * This domain's defects are broken LINKS: a route that does not exist, an endpoint
 * with no record, a ref nobody produces any more. A broken link is only visible when
 * both of its ends are in the same bounded pass — split a chain across two bundles
 * and every gap between them becomes invisible, which is exactly the failure mode P2
 * exists to prevent. So the bundle key is the CHAIN, not the file and not the node.
 *
 * The corpus layout makes that derivable from the path alone:
 *
 *     chains/<chainId>/trace.json    ->  key `chain/<chainId>`
 *
 * That matters more than it looks. The engine's `toCandidates()` keeps only
 * `{path, bytes, additions, deletions, binary, deleted, key}` and DROPS `meta`, so a
 * resolver that read `meta.chain` would work in this domain's own tests and silently
 * degrade to the fallback in the real pipeline. The path is the only input that
 * survives, so the path is what this resolver reads — with `meta.chain` used only as
 * an explicit override when a caller supplied it directly.
 */
export function chainKey(candidate) {
  const declared = candidate?.meta?.chain
  if (typeof declared === 'string' && declared.trim() !== '') return `chain/${declared.trim()}`
  const path = slash(candidate?.path ?? '')
  if (path === '') return 'chain/unknown'
  return `chain/${chainOf(path)}`
}

/**
 * The pack's own exclude list. Deliberately SHORT: `DEFAULT_EXCLUDE_PATTERNS` in
 * `lib/engine.js` already covers `node_modules`, `vendor`, `dist`, `build` and
 * `target` as `default-path`. Restating them here would change which predicate fires
 * — and therefore the reason a report shows — without changing the outcome.
 *
 * The `archived` pattern IS declared here rather than in a fixture: the contract
 * requires that the `all-gated-out` boundary holds under the gate THIS DOMAIN ships.
 * A pattern that only exists in the fixture would prove that the engine honours
 * `options.exclude`, not that this domain excludes retired chains by default.
 */
const DOC_GATE = {
  exclude: ['**/.git/**', '**/archived/**'],
}

/**
 * The document types this domain reads. `.json`/`.yaml`/`.md` are the three a
 * traceability export actually arrives as; `.txt` is deliberately absent so the
 * `all-gated-out` fixture can pin the extension predicate.
 */
const GATE_EXTENSIONS = ['.json', '.yaml', '.yml', '.md', '.csv']

/**
 * NOTE: `candidateSource` is deliberately NOT declared here, and there is not even a
 * named re-export of it.
 *
 * `lib/domain-loader.js` looks for a named `candidateSource` on the module namespace
 * and takes it AS IS when present, falling back to `source.js` only when it is
 * absent. A named export whose value is the *descriptor* rather than the
 * `defineCandidateSource(...)` object would therefore shadow the real sibling and
 * fail `validateCandidateSource` with "enumerate must be a function". The descriptor
 * belongs in the pack (`candidateSet`), and the implementation belongs in
 * `source.js`. Nothing here names `candidateSource`.
 */

/**
 * Named so this domain's own `test.mjs` can call the resolver DIRECTLY and assert the
 * grouping property (one chain holds more than one candidate) rather than asserting
 * `plan.bundleKey.applied` and hoping. `applied: true` is satisfiable by a resolver
 * that returns a unique key per candidate — i.e. by P2 not being done.
 */
export const bundleKey = {
  strategy: 'trace-chain',
  resolve: chainKey,
  description: '按追踪链分捆（语料布局 chains/<chainId>/trace.json，键为 chain/<chainId>）：一条链的两端必须落在同一捆，否则链上的缺口无法被看见。',
}

export default {
  contractVersion: 2,

  id: 'requirement-alignment',
  title: '需求对齐',
  category: 'D',
  keywords: ['traceability', 'alignment', 'requirement', 'trace', 'coverage', 'link', 'meta'],
  summary: '**关系型元领域**：产物是一致性本身。锚点是「节点 ID 对」，跑在锚点链建出的追踪图上；断链、未覆盖需求、失效的跨域 ref 都在图上重算，且能消费其它领域产出的锚点 ID。'
    + ' **可消费的上游锚点形状是一张有限、写死的表**（`source.js` 的 REF_SHAPES，六类：requirement-research 的 `sessions/<sid>/u<n>`；product-planning 的 `requirements/<rid>` 与 `plans/<pid>/serves/<rid>`；diff 系的 `<path>.<代码扩展名>[#L…]`；user-feedback 的 `feedback/…`；project-management 的 `*.json`）。'
    + ' 表外的 ref 本域**无法消费**（实测：operator-design 的 `*.cu`、ui-visual 的 `atoms/…/bg-color`、ux-review 的 `checkout/happy/s1`）：按契约表的 gate 映射标为 binary 并**移出本次评审范围**，只在 `notes` 里逐条列出 ——「移出范围」不等于「没有问题」，那是跨域断链，需要上游补形状或在本表登记。'
    + ' 因此：**领域不在六种节点类型词表（requirement/plan/design/implementation/case/feedback）内，或它的 id 形状不在上表内，本域就不保证可消费**；新形状必须先在 REF_SHAPES 里登记（登记结果由 `test.mjs` 钉住，某个生产者从可消费变成不可消费会让测试变红）。'
    + ' **每次归因都带 `basis`（机器可读）**：`exact` = 该形状唯一指向某一个域（`sessions/*/u*`、`requirements/*`、`plans/*/serves/*`、`feedback/*`）；`form` = 该形状只指向一个**家族**且判不出成员（diff 扩展名路径一类的 `<path>.<ext>`，以及通配的 `*.json`）—— 例如 `src/core/engine.ts` 与 `src/app.ts` 形状逐字同类，`refDomain` 报出的只是家族代表。**看到 `basis: form` 时不要把 `refDomain` 当成事实**：用 `upstream[]` 判定成员与是否仍产出。'
    + ' 另注意：形状匹配只回答「读得懂吗」，**不回答「上游还在产出它吗」** —— 后者只有 `upstream[]` 能回答。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // `recall-first` and `triage` must agree: a missing link is more expensive than a
  // doubtful one, so a finding the graph cannot disprove is KEPT and marked for
  // human confirmation rather than dropped. `criticismKindConsistent` checks exactly
  // this pairing at pack-validation time.
  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'trace-graph-edges',
    inputFormat: 'trace-graph',
    bounded: true,
    description: '追踪图上每条边一个候选，每个节点的每一侧（上游/下游）一个候选。端点未登记不静默丢弃：标为 dangling 交由评审判定。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: GATE_EXTENSIONS,
  },

  // --- P2 ------------------------------------------------------------------
  // The v1 pack declared the private string 'artifact', which is not one of the four
  // strategies the contract knows and would be rejected by the v2 gate. The resolver
  // below implements the SAME semantic grouping the v1 name promised — the chain —
  // rather than degrading to `{ strategy: 'path' }`, which would be one bundle per
  // candidate, i.e. P2 not done.
  //
  // The object is REFERENCED, not restated, so `test.mjs` can import the same
  // `bundleKey` and assert against the resolver that ships.
  bundleKey,

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'trace-node-and-edge',
    verify: 'engine-recomputable',
    description: '锚点是「节点 ID 对（或单个 ID，配 locator {fromId,toId?}）」。引擎在追踪图上重算：该有向边是否存在、kind 是否一致、两端之间是否有且仅有一条路径、端点是否真的没有记录、需求是否真的走不到实现、以及跨域 ref 的形状是否可消费、是否仍在 upstream[] 的产出集合里。方向相反、kind 不符、链断、读法不唯一、ref 无法消费一律判未锚定 —— 绝不猜测。**跨域那一层的边界要看清**：可消费的形状是 `source.js` 的 REF_SHAPES 表（有限、写死；表外的 ref 一律 OPAQUE，既不能确认也不能否定，会被标为 binary 移出评审范围）；归因带 `basis`：`exact` 才是「形状唯一指向这个域」，`form` 只表示「这个形状的家族」（diff 扩展名路径与通配 `*.json` 都是 form，`refDomain` 仅是家族代表）；而「形状可消费」与「上游仍在产出」是两档强度，语料没有声明 `upstream[]` 时第二档**无法回答**，报告不得把它当成通过。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'triage',
    description: '独立一轮只做分级筛选：声明的边/路径/端点在图上是否存在、是否唯一、跨域那一层是否把「形状可消费」说成了「上游仍在产出」。召回优先：只删除被图正面否定的条目，证据不足的一律保留为待人工确认，并逐条列出缺口。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This stays
  // as the v1-shaped fallback the executor falls back to when a prompt function
  // throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是需求对齐评审者，评审的是追踪链的一致性与完整性，不是需求或设计的好坏。',
    instruction: '每条发现给出 claim kind（trace-edge / chain-path / dangling-ref / uncovered-requirement / orphan-node / cross-domain-ref / stale-ref）以及具体的 fromId / toId（或 ref）。',
  },
}
