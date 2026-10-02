/**
 * requirement-alignment — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT enforce
 * that — `validateReviewPrompts` and `validateDomainPackV2` both return `[]` for
 * identical prompts — so an identical pair would sail through the completion gate
 * while quietly deleting the P6 layer: a reviewer "independently re-checking" its own
 * reasoning is not an independent re-check. This domain's `test.mjs` asserts the
 * difference, and `verify()` is built so it CANNOT see the P4 reasoning: it receives
 * findings, never the review transcript, never the rules.
 *
 * WHAT IS DIFFERENT ABOUT A META-DOMAIN'S ANCHOR LAW
 * -------------------------------------------------
 * The subject is not a document and not even one graph: it is the CONSISTENCY of a
 * chain that crosses domains. A node's `ref` is an anchor id owned by a sibling
 * domain, so the anchor law has a second half that ordinary domains do not have:
 *
 *   the graph half — never paraphrase an id, never invent an edge or a route, and
 *                    always name the claim kind;
 *   the meta half  — never treat a `ref` as valid because it LOOKS valid. "It looks
 *                    like a diff-line anchor" is a shape claim; "some domain really
 *                    produced it" is a membership claim, and only `upstream[]`
 *                    answers that. A ref that is no longer in `upstream[]` is a
 *                    STALE LINK, and it is one of this domain's findings.
 *
 * The failure this guards against is specific: an LLM handed a traceability table
 * will write "R1 已由 I1 实现" — a true-looking sentence that names no claim kind and
 * no direction, and that the engine can neither confirm nor refute. Such a finding
 * is unanchored by construction, and both prompts say so.
 *
 * WHERE THE P6 TEXT ACTUALLY GOES (rewritten at t43; the t39 wording is kept below
 * because it explains why this section exists at all)
 * -----------------------------------------------------------------------------------
 * Both prompts RUN. `review()` is rendered by `lib/reasoner.js` `renderReviewPrompt()`
 * for the P4 loop. `verify()` is rendered by the symmetric `renderVerifyPrompt()` and
 * executed by `createReasoner().runVerify()` inside the P6 stage of
 * `adjudication_submit`. Before handing the findings over, `index.js` folds the
 * recomputed verdict onto each finding through the named whitelist
 * `P6_VERDICT_FIELDS` — flat, which is why `attributionFields()` below reads the
 * finding itself — and runs the P6 child with an empty tool filter, so the reviewer
 * cannot read P4's rules, work order or reasoning.
 *
 * The t39 state, recorded because a domain owner reading this file alone would
 * otherwise have to guess it: at that time `verify()` had NO runtime caller anywhere —
 * the contract validators read it, this domain's test read it, and P6's keep/drop
 * decision was made deterministically by `runCritiquePanel()` from the loss
 * orientation. The prompt was a text deliverable, not a running layer. That gap was
 * closed by t41; it is a running layer now.
 *
 * Two limits are real and are stated rather than glossed over: (1) `runVerify()`
 * renders and starts a child only when `ctx.subagents` or `ctx.llm` is mounted —
 * otherwise the run reports `ran === false` / `mode === 'none'` with an
 * `E_NO_REASONER` reason and the report says P6 was not executed, instead of
 * pretending an independent re-check happened; (2) a pack without `reviewPrompts`
 * (the v1 packs) takes the weaker `legacy-verify` text. And P6's verdicts are
 * REPORTED, NOT APPLIED: admission is still decided by the loss orientation and the
 * protected subjects, so an empty P6 run cannot quietly drop findings in a
 * recall-first domain.
 *
 * `recall-first` IS LOAD-BEARING IN BOTH PROMPTS
 * ---------------------------------------------
 * This domain's loss orientation is `recall-first`: missing a real broken link costs
 * more than reporting a doubtful one. That has a concrete consequence the prompts
 * state — a doubtful gap is KEPT and marked for human confirmation, and it is only
 * removed when the graph positively refutes it. It is also why the review prompt
 * forbids percentage summaries: a coverage number can be neither adjudicated nor
 * fixed, and a `recall-first` domain that reports one has thrown away the items it
 * was supposed to keep.
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will assert
 * them as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
})

/**
 * The anchor law, in this domain's vocabulary.
 *
 * Deliberately explicit about the seven claim kinds: a model that does not know what
 * a claimable relationship is will invent one, and the engine will return
 * `kind-mismatch` for every finding in the run.
 */
const ANCHOR_LAW = [
  '锚点铁律：**锚点是 ID 对（或单个 ID），不是描述**。你提交的是 `locator.kind` 加上具体的 `fromId` / `toId`，引擎在追踪图上重算这条关系是否存在。',
  '可以声明的只有七种：`trace-edge`（`{fromId,toId,edgeKind?}` —— 「R1→I1 是一条 implements 边」）、`chain-path`（`{fromId,toId,route?}` —— 「R1 能走到 I1」）、`dangling-ref`（`{fromId,toId?}` —— 「这条边的端点在图上没有节点记录」）、`uncovered-requirement`（`{fromId,toId?}` —— 「这个需求没走到任何实现」）、`orphan-node`（`{fromId}` —— 「这个节点没有任何边」）、`cross-domain-ref`（`{fromId,ref?}` —— 「这个节点的 ref 是可消费的跨域锚点」）、`stale-ref`（`{fromId,ref?}` —— 「这个节点的 ref 上游已经不产出了」）。',
  '候选卡片自带的第八种叫法引擎同样认：`trace-node-side`（`{fromId,side}`，side 为 `upstream` / `downstream` —— 「这个节点在图上有一条记录，这张卡渲染的是它那一侧」）。side 不是 `upstream` 或 `downstream` 会被直接拒绝，不会落到默认值。',
  'ID 必须**逐字抄写**，包括连字符与大小写：`R-12` 不是 `R12`，`I1` 不是 `i1`。写错一个字符，引擎就会判未锚定，而它不会替你猜你想写的是哪个。',
  '**方向是有意义的**：`derives` 是需求指向方案，`informs` 是反馈指向需求。反过来写就是另一条边，引擎会直接判 `locator-mismatch`。',
  '**跨域 ref 有两档强度，不要混用**：形状可消费（`REF_SHAPES` 认得出它属于哪个域）是一档；上游真的还在产出它（出现在 `upstream[]` 里）是另一档。语料没有声明 `upstream[]` 时，第二档**无法回答** —— 必须标为未回答，不得当成通过。',
  '**归因本身也分两档**：`basis: exact` 表示形状唯一指向某个域（`sessions/*/u*`、`requirements/*`、`plans/*/serves/*`、`feedback/*`）；`basis: form` 表示这个形状**多个域都在产出**（例如任何带 diff 扩展名的路径），`refDomain` 只是家族代表。看到 `form` 就**不要**在结论里写成一个确定的域 —— 那是形状给不出、只有 `upstream[]` 能回答的问题。',
  '**不要写「这条链有问题」这类结论**。「R1 覆盖不全」不是可锚定的发现 —— 要么给出它到不了的实现节点，要么给出它断在哪条边上。「有个断链」也不是 —— 要给出具体的边与端点。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '需求对齐'}（${domain?.id ?? 'requirement-alignment'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

/**
 * t39 — the attribution basis of a finding, as the three fields the P6 text shows.
 *
 * `basis` exists because `refDomain` alone is more certain than the shape table
 * actually knows: the diff-extension row identifies a FAMILY of producers, so naming
 * one of them (`code-review`) reads like a fact and is not one. A P6 reviewer that is
 * never told the basis cannot tell the two apart — it will re-check a family-level
 * guess as if it were a membership claim.
 *
 * WHY THE LINE IS ALWAYS RENDERED, EVEN WHEN NOTHING IS KNOWN
 * ----------------------------------------------------------
 * The fields default to the literal `(未给出)` instead of the line being dropped.
 * Omitting it would make "the caller gave no basis" and "the basis is exact" render
 * as the SAME text — i.e. the one case a reviewer must not approve silently would be
 * indistinguishable from the safe case. That is precisely how a rule like this stops
 * applying without anyone noticing.
 *
 * The value is read from the finding itself. The two NESTED spellings are also accepted
 * (`finding.verdict.*` / `finding.anchor.*`) — but that is CALLER TOLERANCE, NOT a shape
 * this repository produces: the engine's fold (`index.js`, `P6_VERDICT_FIELDS`) copies
 * the verdict's fields FLAT onto the finding, and no producer anywhere in the repo emits
 * a nested `verdict` or `anchor` object on a finding. Read those two branches as "a
 * caller may hand us a verdict object that it did not flatten", never as evidence that
 * the nested shape occurs here. (`test.mjs` asserts the real-path finding is flat, so
 * the day a producer starts nesting, that assertion says so instead of this comment
 * quietly becoming false.)
 */
function attributionFields(finding) {
  const sources = [finding, finding?.verdict, finding?.anchor]
    .filter((item) => item !== null && typeof item === 'object')
  const pick = (key) => {
    for (const source of sources) {
      const value = source[key]
      if (typeof value === 'string' && value !== '') return value
    }
    return '(未给出)'
  }
  const basis = pick('refBasis')
  const known = basis === '(未给出)' || basis === 'exact' || basis === 'form'
  return {
    basis: known ? basis : `${basis}（**未知档位 —— 不是 exact/form 之一，需人工确认**）`,
    domain: pick('refDomain'),
    detail: pick('refBasisDetail'),
  }
}

export default defineReviewPrompts({
  /**
   * P4 — the bounded review pass.
   * Receives rules, the bundle's paths and the run's budget; does the judging.
   */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界的追踪链评审（P4）**。被审对象是一张追踪图：节点是需求/方案/设计/实现/用例/反馈，边是它们之间的关系。你只对这张图的**一致性与完整性**负责 —— 不评价需求是否值得做、不评价设计好不好、不评价排期。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 本轮的锚点铁律',
      ...ANCHOR_LAW,
      '',
      '## 元领域的核心：链条跨域，锚点由别人产出',
      '这些节点的 `ref` 不是本域的东西，是**别的域产出的锚点 ID**（需求研究的一句原话、产品规划的一条边、代码评审的一个 diff 行区间、用户反馈的一行）。所以你的判断分两层，不要合并：',
      '- 第一层（图）：这条关系在这张图上存不存在、方向对不对、读法唯不唯一。',
      '- 第二层（跨域）：这个 ref 是不是可消费的形状、上游是否还在产出它。第二层答不了时**说答不了**，不要说「应该没问题」。',
      '- 「链路看起来是完整的」这个整体印象不是证据。链要在图上指出具体的那条边、那段路径、或那个缺记录的端点。',
      '',
      '## 召回优先的后果（本条最容易被违反）',
      '- 允许的结论有三种：`keep`（图上事实正面支持）、`drop`（被图正面否定）、`doubtful`（**证据不足但图也没有否定它**）。',
      '- `doubtful` 必须保留并标注，交由损失取向裁决 —— **不要因为你无法证明它就把它降成「没有问题」**。本域宁可多一条待确认，也不肯漏一条真实的断链。',
      '- 缺环要**逐条列出**：哪条边、哪个端点、哪个需求没走到实现。不许用「覆盖率约 60%」代替清单 —— 百分比无法被裁定，也无法被修复。',
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是评审的经验清单，不是不可质疑的权威。规则与眼前的图冲突时，以图为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按图上的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的文档：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行、≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。图查询同理有上限，触到上限时工具会明说 \`truncated\`。`,
      '- 需要更多图结构时先取证再判断（`gap_report` 给出逐条缺口，`chain_routes` 给出全部读法，`ref_check` 回答跨域那一层）。',
      '- **取证的 `truncated: true` 不是证据**：搜索触到上限时没有找到路径，不等于链没有断。',
      '',
      '## 输出',
      '只输出发现，不输出自然语言位置。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论：一条自洽的链不应该被挑出问题。但**「图很干净」必须是因为图确实干净，而不是因为你没查**。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent re-check.
   *
   * Deliberately shaped so it cannot inherit the P4 reasoning: it is handed findings
   * (claim kinds + ids + the quoted evidence) and nothing else. It may only ask
   * whether the claimed relationship exists and whether it proves the conclusion.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮评审的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对图上的事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问四个问题，按顺序：',
      '1. **这条关系在图里存在吗？** 声明的 ID 对 / 路径 / 端点，逐字核对图上是否真有这条边。ID 对不上、方向反了、路径不存在，直接判不通过，不要替它找一条「它大概想说的」边。',
      '2. **这条关系证明了结论吗？** 即使边存在，也要判断它是否真的支持「这是一条断链」。一条跨团队的依赖边存在，不等于需求没有被实现；一个节点没有 ref，不等于它的上游丢了。',
      '3. **它说的是图上唯一的读法吗？** 如果两个节点共享一个 ID，或者同一对端点之间存在多条路径，这条发现就没有唯一指向 —— 判不通过。',
      '4. **跨域那一层被混淆了吗？** 如果发现断言某条 ref「有效」，要问：这是**形状**结论还是**成员**结论？语料没有声明 `upstream[]` 时，成员结论**无法回答** —— 把形状结论说成成员结论的，判不通过。再查一层：归因的 `basis` 是 `exact` 还是 `form`？`form` 意味着这个形状**多个域都在产出**，把 `refDomain` 写成一个确定的域就是**给出比实际知道的更确定的答案** —— 判不通过。',
      '只做这四件事。不要补充新发现，不要重写这条发现的措辞，不要因为「这条链整体看着还行」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '注意召回优先对 P6 的含义：**「图没有否定它」不是删除的理由**。你只能删除被图**正面否定**的发现；证据不足的一律保留为待人工确认。',
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算图上的事实正面支持它。',
      '允许的结论只有三种：`keep`（图上事实正面支持）、`drop`（被图正面否定）、`undecided`（存疑，交由损失取向裁决）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为找到了这条发现、就顺手认可它的严重度或修复建议。',
      '- 不可以在 ID 或方向对不上时「折中」：对不上就是未锚定。',
      '- 不可以把「这条链整体上很完整」当成任何一条发现的证据 —— 那是印象，不是图上的边。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。一条自洽的链本来就该输出空集。)'
        : findings.map((finding, index) => {
          // t39 — the attribution basis is part of the finding a P6 reviewer sees, and
          // it is rendered even when absent (see `attributionFields`).
          const attribution = attributionFields(finding)
          return [
            `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
            `- 声称位置：${finding?.path ?? '(未给出)'}`,
            `- 声称的关系：${finding?.claim ?? finding?.locator?.kind ?? '(未声明 claim kind —— 未声明即为未锚定)'}`,
            `- 涉及的 ID：${Array.isArray(finding?.nodes) && finding.nodes.length > 0 ? finding.nodes.join(', ') : '(未给出 ID —— 未给出 ID 即为未锚定)'}`,
            `- 涉及的跨域 ref（若给出）：${typeof finding?.ref === 'string' && finding.ref !== '' ? finding.ref : '(未给出)'}`,
            `- 归因档位（若给出）：basis=${attribution.basis}，refDomain=${attribution.domain}，家族说明=${attribution.detail}`,
            `- 结论：${finding?.message ?? '(未给出)'}`,
            `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
          ].join('\n')
        }).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体的正面反证（ID 不存在 / 方向相反 / 路径不存在 / 该边不证明此结论 / 读法不唯一）。',
      '「证据不足」不是 `drop` 的理由，是 `undecided`。',
    ].join('\n')

    return { system, instructions }
  },
})
