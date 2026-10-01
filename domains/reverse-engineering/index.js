/**
 * reverse-engineering — domain package v2.
 *
 * This directory is the same `reverse-engineering` domain `lib/domains.js`
 * declares as a v1 pack, expressed in the v2 shape: a candidate source, an anchor
 * verifier, bounded evidence tools, two independent prompt roles, a real rule
 * library and fixtures. When the loader discovers
 * `domains/reverse-engineering/`, this pack REPLACES the v1 entry of the same id —
 * that replacement is the migration path, and it is why the v1 file is untouched.
 *
 * THIS IS A C (EXPLORATION) DOMAIN, AND IT SAYS SO IN THE DATA
 * -----------------------------------------------------------
 * `candidateSet.bounded === false`, and the honest statement of its cost model
 * travels with every result instead of living in a README:
 *
 *   候选集不可先验枚举、成本无上界。
 *
 * `source.js` emits that sentence as a note on EVERY run (including the empty one,
 * which is exactly the run that would otherwise read as "nothing to see here");
 * `prompts.js` states it in both prompt roles; `test.mjs` asserts it reaches
 * `plan.candidateSet.notes`. `checkContractIntegrity` only permits
 * `bounded: false` for the two C domains, so the claim is checkable.
 *
 * The second law is the evidence level: an OBSERVATION has reproduction steps, an
 * INFERENCE is a hypothesis (猜想). `anchor.js` refuses a claim that presents an
 * unreproduced inference as verified, and it refuses a claim whose sample hash is
 * not the registered one — offsets and signatures move between builds.
 *
 * THE FIVE EXTENSION POINTS ARE NOT INLINED HERE. `source.js`, `anchor.js`,
 * `evidence.js`, `prompts.js` and `rules/*.md` are assembled by
 * `lib/domain-loader.js`; this file declares only what must live at the pack
 * level. That is what keeps `validateDomainPackV2` meaningful for the assembled
 * object rather than for a hand-made one.
 *
 * HONESTY: `rules/*.md` is 20 agent-drafted rule documents, every one carrying
 * `needs-expert-review: true`. They are NOT an expert-validated standard, and
 * nothing in this package claims otherwise. Nothing here is legal advice.
 */

import { leadKeyFromPath } from './source.js'

/**
 * The pack's own exclude list. Deliberately SHORT and a subset of the engine's
 * defaults: `DEFAULT_EXCLUDE_PATTERNS` already covers `node_modules`, `vendor`,
 * `dist`, `build`, `target` and lock files as `default-path`. Restating them would
 * change which predicate fires — and therefore the reason a report shows —
 * without changing the outcome.
 */
const DOC_GATE = {
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/archive/**'],
  // CHANGED (t33/t24): `**/archive/**` is declared HERE, by the pack. The
  // all-gated-out fixture used to supply it, which only proved that the engine
  // honours `options.exclude`. Superseded leads are archived for provenance and
  // are not part of the default review surface; a fixture-supplied pattern is
  // not a claim about this domain.
}

export default {
  contractVersion: 2,

  id: 'reverse-engineering',
  title: '逆向工程',
  category: 'C',
  keywords: ['reverse', 'firmware', 'binary', 'disassembly', 'protocol', 'malware', 'artifact', 'observation'],
  summary: '对逆向笔记做有界评审：每条线索（lead）一组候选，产物身份行一个，每条陈述的原文行与可复现性行各一个；锚点先重算样本哈希与复现状态，再在笔记里逐字定位。不可复现的推断必须保留猜想标注。候选集不可先验枚举、成本无上界，这一点写进每次结果。支持边界（t33 实测，测试里钉住）：三种已声明后缀（.md/.txt/.json）在 observations/ 子树内都能拿到该族 20 条规则；出了这棵子树只有 .json（还有 log 家族）能命中 20 条，.md/.txt 为 0，因为规则 glob 是 observations 子树与 json/log 兜底 —— 这是被声明的边界，不是遗漏。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // recall-first: a missed "this is actually reachable" costs far more than a
  // kept hypothesis, so P6 only removes what evidence POSITIVELY disproves.
  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'artifact-observations',
    inputFormat: 'artifact-and-observations',
    // A C domain. `checkContractIntegrity` allows this only here and in
    // `market-research`; a target artifact does not come with a question list.
    bounded: false,
    description: '目标产物（sha256 必填）+ 观察/推断。每条线索一组候选：产物身份行一个，每条陈述的原文行与可复现性行各一个；候选路径是线索笔记 re/<artifact>/observations/<lead>.md，因此一条线索的陈述与它的复现状态必然同捆。**候选集不可先验枚举、成本无上界**：列出的只是 seed 里已经提出的观察。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: ['.md', '.txt', '.json'],
  },

  // --- P2 ------------------------------------------------------------------
  // The v2 object form. `re-lead` is NOT one of the generic strategies
  // (`path`/`file`/`directory`/`extension`) — a bundle here is "one LEAD against
  // one artifact" (a hypothesis and the observation that supports or kills it
  // belong together, because judging either alone is how an inference gets
  // promoted to a fact) — so the pack supplies `resolve`, as the contract
  // requires of a private strategy name.
  //
  // Why this is not `{ strategy: 'path' }`: grouping by path would put each
  // candidate in its own bundle the moment a note is not shared, i.e. P2 doing
  // nothing while reporting `applied: true`. `test.mjs` proves that the several
  // candidates of one lead really do land in ONE bundle.
  bundleKey: {
    strategy: 're-lead',
    // Derived from the candidate's PATH, and that is not an implementation
    // detail: through `adjudication_plan` the engine normalises every candidate
    // to `{path, bytes, additions, deletions, binary, deleted, key}` — `meta`
    // does not survive `toCandidates()`. A key read out of `meta.lead` would
    // degrade to one-bundle-per-candidate in the plan while still reporting
    // `applied: true`. So the candidate's path IS the lead's note file (see
    // `source.js`) and the key is that note read back out of the path.
    resolve: (candidate) => leadKeyFromPath(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'reproducible-observation',
    verify: 'engine-recomputable',
    description: '模型逐字抄写它依据的那一行，并声明这条证据属于哪个产物（artifactId / sha256）与哪条观察（observationId）。引擎先重算样本（哈希不一致即结论不能搬运），再重算复现状态（steps=0 或 verified=false 的陈述是猜想，被写成已验证即拒绝），最后在线索笔记里逐字滑窗定位；转述不锚定，同一行命中多处时拒绝猜测。',
  },

  // --- P6 ------------------------------------------------------------------
  // `triage` is the shape recall-first implies; `criticismKindConsistent` checks
  // exactly this pairing at pack-validation time. It labels the reviewer and
  // selects the P6 prompt; it never decides keep/drop — a triage reviewer that
  // deleted findings would be a precision-first reflex in a recall-first domain.
  criticism: {
    kind: 'triage',
    description: '独立一轮只做分级筛选：核对原文是否逐字存在、是不是同一个样本、复现状态有没有被升级。只删除被证据正面否定的发现，证据不足一律标注后交人工；结论是「已验证 / 未验证」的标注，不是删除。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This
  // stays as the v1-shaped fallback the executor falls back to when a prompt
  // function throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是一名资深逆向工程师，只对本次线索范围内的、有逐字证据的结论给出意见。',
    instruction: '每条意见必须绑定目标产物的 sha256，并逐字引用依据的那一行；不可复现的推断必须标注为猜想，不得写成已验证的观察。',
  },
}
