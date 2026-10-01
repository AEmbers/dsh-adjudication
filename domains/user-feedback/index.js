/**
 * user-feedback — domain package v2 (D family, 关系型).
 *
 * WHY THIS DIRECTORY EXISTS
 * -------------------------
 * `lib/domains.js` still holds the nineteen v1 packs, and this is the same
 * `user-feedback` domain expressed as the v2 package the contract describes: a
 * candidate source, an anchor verifier, bounded evidence tools, two independent
 * prompt roles, a real rule library and fixtures. When the loader discovers
 * `domains/user-feedback/`, this pack REPLACES the v1 entry of the same id — that
 * replacement is the migration path, and it is why the v1 file is untouched.
 *
 * WHAT A D DOMAIN'S PRODUCT IS, AND WHAT MAKES THIS ONE RECALL-FIRST
 * -----------------------------------------------------------------
 * Not "something is wrong at this location" but "the relationship between these two
 * things is wrong". A feedback item can be perfectly recorded — verbatim quote, clear
 * severity, a named source — and still be silently lost, because a decision record
 * that never mentions it is not a defect OF that record.
 *
 * `recall-first` is the honest orientation for that: a feedback item dropped without a
 * trace is a user who reported something and was ignored without anyone recording the
 * decision to ignore it. So a missed item costs more than a speculative one, and the
 * engine marks an incomplete coverage run as NOT complete
 * (`requireComplete: lossOrientation === 'recall-first'`). Two consequences are wired
 * through this pack rather than left to the prompt:
 *
 *   • `evidence.js` ships `unclosed_feedback`, which lists EVERY gap instead of
 *     returning a count — "8 of 14 closed" hides the six that are the deliverable.
 *   • `source.js` exports `ledgerRanks`, which keeps severity x reach and report
 *     count as two SEPARATE rankings and names `drownRisk` — the high-loss,
 *     low-frequency items a count-sorted triage buries.
 *
 * Both are asserted in `test.mjs` against a fixture built so the two orderings
 * disagree; neither is a formatting preference.
 *
 * THE PROPERTY THAT MAKES THE ANCHOR A HARD CONSTRAINT
 * ----------------------------------------------------
 * `anchor.verify` is `engine-recomputable`: given the ledger, the engine re-derives
 * whether a closure is MUTUAL, whether a decision really has no counterpart, and
 * whether a submitted quote verbatim occurs in the record. A model cannot get a
 * finding accepted by paraphrasing a user's complaint into something clearer. The
 * refusals that make that true — one-sided closure, paraphrased quote, role-swapped
 * id, ambiguous quote — are implemented in `anchor.js` and exercised against fixtures
 * that contain them.
 *
 * THE FIVE EXTENSION POINTS ARE NOT INLINE HERE
 * ---------------------------------------------
 * `candidateSource`, `anchorVerifier`, `evidenceTools`, `reviewPrompts` and
 * `ruleLibrary` are assembled by `lib/domain-loader.js` from the sibling files
 * (`source.js`, `anchor.js`, `evidence.js`, `prompts.js`, `rules/*.md`). This file
 * declares only what the pack ALONE knows. Note the comment on `candidateSource`
 * below: naming that export here would SHADOW `source.js` and break the load.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` is a set of agent-drafted rule documents. Every one carries
 * `needs-expert-review: true`, and the prompt text says so to the model. This is a
 * draft library with a working engine around it — NOT an expert-validated
 * customer-feedback standard. `lib/domains.js` v1 shipped four seed rules for this
 * domain; hand-written drafts still are not an expert library. The difference is that
 * the gap is now visible instead of implicit.
 */

import { directoryOf, slash } from '../_lib/graph.js'

/**
 * The ledger's natural grouping is the FEEDBACK THEME, not the file.
 *
 * Two reasons, and the second is the one that matters:
 *
 *   1. Cost. A bounded pass should hold one theme's items and the decisions that
 *      touch them, so the reviewer can see a whole complaint cluster at once.
 *      Splitting per file would put every theme in one bundle, which is both larger
 *      and less coherent.
 *
 *   2. Correctness. This domain's defects are relations, and a theme is the unit in
 *      which a relation is legible: "twelve people reported the same checkout bug and
 *      no decision mentions any of them" is only visible if those twelve items sit in
 *      one bundle together. Grouping by path would spread them across every bundle the
 *      ledger was split into, and a cross-theme cluster could never be seen at all.
 *
 * Falls back to the ledger document's path, then to its directory, so a caller who
 * hand-feeds `candidates` without `meta.theme` still gets a deterministic,
 * non-degenerate grouping.
 */
export function themeKey(candidate) {
  const theme = candidate?.meta?.theme
  if (typeof theme === 'string' && theme !== '') return `theme/${theme}`
  const documentPath = candidate?.meta?.ledgerPath
  if (typeof documentPath === 'string' && documentPath !== '') return `doc/${slash(documentPath)}`
  return `dir/${directoryOf(candidate?.path, 2)}`
}

/**
 * The pack's own exclude list. Deliberately SHORT: `DEFAULT_EXCLUDE_PATTERNS` in
 * `lib/engine.js` already covers `node_modules`, `vendor`, `dist`, `build` and
 * `target` as `default-path`. Restating them here would change WHICH predicate fires —
 * and therefore the reason a report shows — without changing the outcome, which makes
 * the reason worse for no gain.
 */
const DOC_GATE = {
  exclude: ['**/node_modules/**', '**/.git/**', '**/archived/**'],
}

/**
 * The document types a ledger export arrives as. `.txt` is deliberately absent so the
 * `all-gated-out` fixture can pin the extension predicate.
 *
 * EXPORTED so `test.mjs` can compute the intersection of this list with the
 * `match` globs on `rules/*.md` from the pack's OWN declaration instead of from a
 * hand-copied list — a copy drifts the moment someone adds an extension.
 *
 * The two halves are independent and both can be individually right while their
 * intersection is EMPTY: the gate admits a `.md` ledger, the rule loader injects
 * nothing, and the ledger is reviewed with an empty rule set. That was a real
 * defect here (`.md` admitted 4 candidates with 0 rules) and no assertion caught
 * it, because every assertion was written about `.json`. This domain is
 * recall-first: a review running with no rules does not raise fewer findings, it
 * merely stops noticing the ones the rules encode, so the loss lands exactly on
 * the class of item this domain exists to not drop.
 *
 * Fixed by widening the rule globs, not by narrowing this list, because this list
 * is the honest one: the caller hands over an already-parsed payload, so any of
 * these serializations is genuinely readable, and the rules are about the LEDGER,
 * not about the syntax it arrived in.
 */
export const GATE_EXTENSIONS = ['.json', '.yaml', '.yml', '.md', '.csv']

/**
 * NOTE: `candidateSource` is deliberately NOT declared here, and there is not even a
 * named re-export of it.
 *
 * `lib/domain-loader.js` looks for a named `candidateSource` on the module namespace
 * and takes it AS IS when present, falling back to `source.js` only when it is absent.
 * A named export whose value is the DESCRIPTOR rather than the
 * `defineCandidateSource(...)` object would therefore shadow the real sibling and fail
 * `validateCandidateSource` with "enumerate must be a function" — a real failure this
 * family already hit once. The descriptor belongs in the pack (`candidateSet`), and
 * the implementation belongs in `source.js`. Nothing here names `candidateSource`.
 */

/**
 * Named so the domain's own `test.mjs` can call the resolver DIRECTLY and assert the
 * grouping property (`theme/checkout` holds more than one candidate) rather than
 * asserting `plan.bundleKey.applied` and hoping. `applied: true` is satisfiable by a
 * resolver that returns a unique key per candidate — i.e. by P2 not being done.
 */
export const bundleKey = {
  strategy: 'theme',
  resolve: themeKey,
  description: '按反馈主题（feedback.theme ?? 文档路径）分捆：同一主题的反馈条目与涉及它们的决策必须落在同一捆，否则「十二条同主题反馈无人处理」这类关系无法被看见。',
}

export default {
  contractVersion: 2,

  id: 'user-feedback',
  title: '用户反馈',
  category: 'D',
  keywords: ['feedback', 'voice-of-customer', 'closure', 'triage', 'severity', 'theme', 'decision'],
  summary: '**关系型**：产物是「反馈 ↔ 决策」两半之间的一致性。锚点是反馈 ID＋决策 ID（或反馈 ID＋逐字引文），闭环必须两侧互证；单边声明、转述引文、失效链接都在台账上重算。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // `recall-first` and `triage` must agree. `validateDomainPackV2` rejects the
  // mismatched pairing, and the engine turns `recall-first` into
  // `requireComplete: true` — an incomplete run is reported as NOT complete rather
  // than silently rounded up.
  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'feedback-to-decision-links',
    inputFormat: 'feedback-ledger',
    bounded: true,
    description: '反馈台账上每条「反馈 ↔ 决策」链接一个候选（`addresses` 与 `closedBy` 两种声明去重后），每条反馈、每个决策、每个主题各一个节点候选。单边声明不合并、未登记的引用不静默丢弃。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: GATE_EXTENSIONS,
  },

  // --- P2 ------------------------------------------------------------------
  // The v1 pack declared the private string 'theme', which is not one of the four
  // strategies the contract knows and would be rejected by the v2 gate. The resolver
  // below implements the SAME semantic grouping the v1 name promised, rather than
  // degrading to `{ strategy: 'path' }` (one bundle per candidate, i.e. P2 not done).
  //
  // The object is REFERENCED, not restated, so `test.mjs` can import the same
  // `bundleKey` and assert against the resolver that ships.
  bundleKey,

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'feedback-and-quote',
    verify: 'engine-recomputable',
    description: '锚点是「反馈 ID＋决策 ID」或「反馈 ID＋逐字引文」。引擎在台账上重算：闭环是否两侧互证、决策是否真的没有相连项、引文是否逐字出现在记录原话里。单边声明、转述引文、ID 角色错位、引文不唯一一律判未锚定。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'triage',
    description: '独立一轮只做分级筛选：这条关系在台账上是否成立、是否真的证明了结论。只在事实**正面否定**时删除 —— 「复核时没看到」是存疑，不是否定。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This stays
  // as the v1-shaped fallback the executor falls back to when a prompt function
  // throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是用户反馈评审者，评审的是反馈台账两半之间的一致性与闭环完整性，不是用户说得对不对，也不是产品该不该做。',
    instruction: '每条发现给出反馈 ID 与决策 ID（或逐字引文）并声明 claim kind；闭环只有两侧互证才算成立，缺口必须逐条列出，严重度与频次必须分开排序。',
  },
}
