/**
 * risk-compliance — domain package v2 (A 审定型, recall-first).
 *
 * WHY THIS DOMAIN IS THE ONE THAT MUST NOT BE WRONG
 * -------------------------------------------------
 * Everywhere else a false positive costs a reviewer a few minutes. Here a
 * MISSED item costs an incident: a retention promise that was never implemented,
 * a cross-border transfer nobody declared, a permission edge that trusts the
 * internal network. So the pack declares `recall-first`, and the engine's loss
 * policy keeps a doubtful finding unless the evidence POSITIVELY disproves it —
 * `criticism.kind: 'triage'` is the reviewer shape that orientation implies, and
 * `validateDomainPackV2` checks the pairing rather than trusting it.
 *
 * THE DUAL ANCHOR (this domain's hard constraint)
 * ----------------------------------------------
 * `clause-and-evidence`: BOTH halves are mandatory.
 *   • the RULE side — a clause id that really exists in the clause register;
 *   • the EVIDENCE side — the verbatim text, re-located by the engine.
 * Either half alone is `unanchored`. A finding without a clause is not a
 * compliance finding, and a finding without quotable evidence is an opinion.
 * `anchor.js` enforces exactly that; see its tier table.
 *
 * WHAT IS HONEST ABOUT IT
 * -----------------------
 * `rules/*.md` are 26 agent-drafted rule documents, every one carrying
 * `needs-expert-review: true`. They are a DRAFT of a compliance rule library.
 * No lawyer, DPO or auditor has reviewed them, and nothing here claims
 * otherwise: the prompt text says so to the model, and the rules tool says so to
 * the user. Treating this library as an authoritative compliance standard would
 * be the exact failure this package exists to prevent.
 */

/**
 * The pack's own exclude list. The Markdown exclusion is this domain's natural
 * noise filter:
 * a clause dump or a policy memo is an INPUT to this domain (it is the rule
 * side), never a regulated surface to adjudicate. Everything else in the
 * engine's `DEFAULT_EXCLUDE_PATTERNS` stays where it is — restating
 * `node_modules`/`vendor` here would change the reported predicate without
 * changing the outcome.
 */
const DOC_GATE = {
  exclude: ['**/.git/**', '**/dist/**', '**/build/**', '**/*.md'],
}

export default {
  contractVersion: 2,

  id: 'risk-compliance',
  title: '风控合规监察',
  category: 'A',
  keywords: ['risk', 'compliance', 'audit', 'regulation', 'policy', 'gdpr', 'security', 'privacy'],
  summary: '把制度条款当作规则库，对受监管面逐条取证。**默认 recall-first**：漏掉一条合规问题的事故成本远高于误报；存疑项保留并标记待人工确认。锚点是双锚点——条款 ID（规则侧）+ 证据原文（受审侧），缺一即判未锚定。',
  status: 'ready',
  rulesStatus: 'draft-v2',

  // --- P6 loss policy -------------------------------------------------------
  // recall-first => triage. `criticism.kind` selects the reviewer's SHAPE and is
  // never used to compute keep/drop (that stays with `lossOrientation`).
  lossOrientation: 'recall-first',

  // --- P0 ------------------------------------------------------------------
  candidateSet: {
    kind: 'regulated-surface',
    inputFormat: 'clause-and-surface',
    bounded: true,
    description: '受监管的行为面（数据流向、权限边、对外接口、留存策略、日志内容）与制度条款的每一对 (条款, 面) 绑定。条款的 appliesTo 决定它管辖哪些面。',
  },

  // --- P1 ------------------------------------------------------------------
  gate: DOC_GATE,

  // --- P2 ------------------------------------------------------------------
  // The v2 OBJECT form with an explicit `resolve`: this domain's real grouping
  // key is "one instrument clause", not a file path. `{ strategy: 'path' }`
  // would be one bundle per candidate — P2 would be decorative — and for a
  // recall-first domain that is exactly the wrong place to save effort.
  //
  // The key is the clause scope, which `source.js` puts on every candidate as
  // the FIRST SEGMENT of `candidate.path` (`<clause-scope>/<surface-path>`). The
  // resolver reads `meta.clauseScope` when the candidate shape still carries
  // `meta`, and falls back to that leading segment otherwise — both spellings
  // produce the same string, so grouping is the same at every layer.
  bundleKey: {
    strategy: 'clause',
    resolve: (candidate) => String(candidate?.meta?.clauseScope ?? candidate?.path ?? '').split('/')[0],
  },

  // --- P5 ------------------------------------------------------------------
  anchor: {
    kind: 'clause-and-evidence',
    verify: 'engine-recomputable',
    description: '双锚点：条款 ID（规则侧，引擎在条款清单里重算）+ 证据原文（受审侧，模型抄写、引擎滑窗定位）。两者缺一即判未锚定——只有条款没有原文是无据的指控，只有原文没有条款不是合规发现。',
  },

  // --- P6 ------------------------------------------------------------------
  criticism: {
    kind: 'triage',
    description: '复核者只删除被证据**正面否定**的发现；存疑项一律保留并标记为待人工确认。存疑不是删除的理由，只是标注的理由。',
  },

  // --- Protected subjects ---------------------------------------------------
  // Read by `runCritiquePanel` BEFORE the correctness judgement, in BOTH
  // orientations: a finding about one of these categories is never silently
  // dropped for lack of proof.
  protectedSubjects: ['security', 'privacy', 'safety', 'data-loss', 'legal'],

  // --- P4/P6 fallback -------------------------------------------------------
  // `reviewPrompts` lives in `prompts.js` and is assembled by the loader. This
  // stays as the v1-shaped fallback the executor falls back to when a prompt
  // function throws — a missing prompt must never take the pipeline down.
  prompt: {
    role: '你是合规监察员。你的损失取向是 recall-first：存疑即保留，只有证据正面否定时才删除。',
    instruction: '每条发现必须同时给出条款依据与证据原文。无法给出条款依据的，标记为「待定条款」而不是丢弃。',
  },
}
