/**
 * market-research — domain package v2.
 *
 * This directory is the same `market-research` domain `lib/domains.js` declares
 * as a v1 pack, expressed in the v2 shape: a candidate source, an anchor
 * verifier, bounded evidence tools, two independent prompt roles, a real rule
 * library and fixtures. When the loader discovers `domains/market-research/`,
 * this pack REPLACES the v1 entry of the same id — that replacement is the
 * migration path, and it is why the v1 file is untouched.
 *
 * THIS IS A C (EXPLORATION) DOMAIN, AND IT SAYS SO IN THE DATA
 * -----------------------------------------------------------
 * `candidateSet.bounded === false`, and the honest statement of its cost model
 * travels with every result instead of living in a README:
 *
 *   候选集不可先验枚举、成本无上界。
 *
 * `source.js` emits that sentence as a note on EVERY run (including the empty
 * one, which is exactly the run that would otherwise read as "nothing found,
 * therefore fine"); `prompts.js` states it in both prompt roles; `test.mjs`
 * asserts it reaches `plan.candidateSet.notes`. `checkContractIntegrity` only
 * permits `bounded: false` for the two C domains, so the claim is checkable.
 *
 * The second law is evidence strength: 一手 / 二手 / 推测. A claim is never
 * stronger than the source it rests on, and an unlabelled source is treated as
 * 推测 rather than guessed upward — `anchor.js` refuses a laundered claim before
 * it even reads the quotation.
 *
 * THE FIVE EXTENSION POINTS ARE NOT INLINED HERE. `source.js`, `anchor.js`,
 * `evidence.js`, `prompts.js` and `rules/*.md` are assembled by
 * `lib/domain-loader.js`; this file declares only what must live at the pack
 * level. That is what keeps `validateDomainPackV2` meaningful for the assembled
 * object rather than for a hand-made one.
 *
 * HONESTY: `rules/*.md` is 21 agent-drafted rule documents, every one carrying
 * `needs-expert-review: true`. They are NOT an expert-validated standard, and
 * nothing in this package claims otherwise.
 */

import { sourceKeyFromPath } from './source.js'

/**
 * The pack's own exclude list. Deliberately SHORT and a subset of the engine's
 * defaults: `DEFAULT_EXCLUDE_PATTERNS` already covers `node_modules`, `vendor`,
 * `dist`, `build`, `target` and lock files as `default-path`. Restating them
 * would change which predicate fires — and therefore the reason a report shows —
 * without changing the outcome.
 */
const DOC_GATE = {
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/archive/**'],
  // CHANGED (t33/t24): `**/archive/**` is declared HERE, by the pack. The
  // all-gated-out fixture used to supply it, which only proved that the engine
  // honours `options.exclude`. Archived material stays on disk for provenance
  // and is not part of the default review surface — a fixture-supplied pattern
  // would not be a claim about this domain.
}

export default {
  contractVersion: 2,

  id: 'market-research',
  title: '市场调研',
  category: 'C',
  keywords: ['market', 'research', 'competitive', 'sizing', 'pricing', 'survey', 'evidence', 'source'],
  summary: '对研究 seed 做有界评审：每个来源一条「证据强度」候选、每条逐字引文一条、每条结论一条；锚点先重算结论是否比来源更强，再在来源卡片里逐字定位引文。候选集不可先验枚举、成本无上界，这一点写进每次结果。支持边界（t33 实测，测试里钉住）：三种已声明后缀（.md/.txt/.json）在 seed 的 sources/ 子树内都能拿到该族 21 条规则；出了这棵子树只有 .md 还有 21 条（其余为 0），因为规则 glob 是 sources 子树与通用 markdown 兜底 —— 这是被声明的边界，不是遗漏。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // recall-first: a missed 二手-source-as-fact costs far more than a kept
  // suspicion, so P6 only removes what evidence POSITIVELY disproves.
  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'sources-and-claims',
    inputFormat: 'research-seed',
    // A C domain. `checkContractIntegrity` allows this only here and in
    // `reverse-engineering`; a research seed is a starting point, not a corpus.
    bounded: false,
    description: '研究 seed（问题 + 已知来源 + 结论）。每个来源一条证据强度候选、每条逐字引文一条候选、每条结论一条候选；候选路径是来源卡片 research/<question>/sources/<source>.md。无 http(s) URL 的来源进 excluded。**候选集不可先验枚举、成本无上界**：列出的只是已知集合，开放式检索能翻出的来源没有任何枚举器能先验列出。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: {
    ...DOC_GATE,
    extensions: ['.md', '.txt', '.json'],
  },

  // --- P2 ------------------------------------------------------------------
  // The v2 object form. `research-source` is NOT one of the generic strategies
  // (`path`/`file`/`directory`/`extension`) — a bundle here is "one SOURCE" (its
  // strength line, its quotations and the claims resting on it belong together,
  // because judging a quotation without its strength label is exactly the
  // laundering this domain exists to catch) — so the pack supplies `resolve`, as
  // the contract requires of a private strategy name.
  //
  // Why this is not `{ strategy: 'path' }`: grouping by path would put each
  // candidate in its own bundle the moment a card is not shared, i.e. P2 doing
  // nothing while reporting `applied: true`. `test.mjs` proves that the several
  // candidates of one source really do land in ONE bundle.
  bundleKey: {
    strategy: 'research-source',
    // Derived from the candidate's PATH, and that is not an implementation
    // detail: through `adjudication_plan` the engine normalises every candidate
    // to `{path, bytes, additions, deletions, binary, deleted, key}` — `meta`
    // does not survive `toCandidates()`. A key read out of `meta.card` would
    // degrade to one-bundle-per-candidate in the plan while still reporting
    // `applied: true`. So the candidate's path IS the source card (see
    // `source.js`) and the key is that card read back out of the path.
    resolve: (candidate) => sourceKeyFromPath(candidate?.path),
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'source-quote',
    verify: 'engine-recomputable',
    description: '模型逐字抄写它依据的那一行，并声明这条证据属于哪个来源（sourceId）与哪条结论（claimId）。引擎先在来源登记表里重算证据强度（来源存在吗？结论是否比来源更强？未声明强度按推测处理），再在来源卡片里逐字滑窗定位；转述不锚定，同一行命中多份卡片时拒绝猜测并列出全部候选路径。',
  },

  // --- P6 ------------------------------------------------------------------
  // `triage` is the shape recall-first implies; `criticismKindConsistent`
  // checks exactly this pairing at pack-validation time. It labels the reviewer
  // and selects the P6 prompt; it never decides keep/drop — a triage reviewer
  // that deleted findings would be a precision-first reflex in a recall-first
  // domain.
  criticism: {
    kind: 'triage',
    description: '独立一轮只做分级筛选：核对引文是否逐字存在、证据强度是否被夸大、归属是否正确。只删除被证据正面否定的发现，证据不足一律标注后交人工；结论是「已验证 / 未验证」的标注，不是删除。',
  },

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This
  // stays as the v1-shaped fallback the executor falls back to when a prompt
  // function throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是一名资深市场研究员，只对本次来源范围内的、有逐字证据的结论给出意见。',
    instruction: '每条意见必须标注依据的来源路径与证据强度（一手/二手/推测），并逐字引用那一行；不得声称已经覆盖整个市场。',
  },
}
