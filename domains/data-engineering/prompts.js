/**
 * data-engineering — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT
 * enforce that, so an identical pair would sail through the completion gate
 * while quietly deleting the P6 layer: a reviewer "independently re-checking"
 * its own reasoning is not an independent re-check. This domain's `test.mjs`
 * asserts the difference, and `verify()` is built so that it CANNOT see the P4
 * reasoning: it receives findings, never the review transcript or the rules.
 *
 * P4 (`review`)  — bounded, rule-injected, allowed to reason about the pipeline.
 * P6 (`verify`)  — adversarial triage, forbidden to reason about intent, allowed
 *                  only to ask "does this text exist, and does the graph really
 *                  contain this edge".
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will
 * assert them as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
})

/** The invariants both prompts state, because both are the model's job to honour. */
const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写你依据的那一行 SQL（含标点、括号、引号、缩进），引擎用滑窗自行定位。',
  '血缘铁律：一条边的存在与否**以血缘图为准**（节点的 inputs/outputs），不是以 SQL 文本为准。你在 SQL 里读到一个表名，不等于图上存在这条边。',
  '字段铁律：声称某个字段有问题时，必须同时给出表名与字段名，并引用它出现的那一行；schema 里没有的字段不构成发现。',
  '只忽略缩进与 diff 标记的差异，标点与标识符必须逐字一致。你写的是转述，引擎就会判定未锚定。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '数据工程' }（${domain?.id ?? 'data-engineering'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /**
   * P4 — the bounded review pass over one bundle (one lineage chain).
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
      '你正在执行**一轮有界数据工程评审（P4）**：一条血缘链 / 一张表，一个新模型。只对本轮范围内的节点负责，既有历史问题不算。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 本轮的铁律',
      ...ANCHOR_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是经验清单，不是不可质疑的权威。规则与眼前的图/代码冲突时，以图与代码为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按血缘图与 SQL 的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 你在找什么（本领域的典型失败模式）',
      '- 血缘图与调度：节点声称的 inputs/outputs 与它实际读写的表不一致；边存在但没有任何下游消费。',
      '- 字段契约：可空性变化、类型收窄/放宽、字段在新链路上被静默丢弃、聚合口径改变。',
      '- 幂等与时间语义：重跑会不会翻倍、增量窗口重叠、时区与水位线（watermark）不一致。',
      '- 无界与代价：全表扫描、缺失分区裁剪、笛卡尔积。',
      '',
      '## 工作方式',
      `- 本轮负责的路径：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行，检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 用 lineage_walk 确认一条边真的存在，再用 node_sql_excerpt 抄下依据的那一行；取证不到就降级为「证据不足」，而不是提高语气。',
      '- 每条发现给出：path、nodeId、抄写的原文、你判断它为什么是问题、以及反方可能怎么说（defended 的依据）。',
      '',
      '## 输出',
      '只输出发现，不输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent triage.
   *
   * Deliberately shaped so it cannot inherit the P4 reasoning: it is handed
   * findings (claims + their quoted text) and nothing else. It may only ask
   * whether the quoted text exists and whether the graph really contains the
   * edge the claim depends on.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮评审的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问三个问题，按顺序：',
      '1. **原文存在吗？** 抄写的那一行，是否逐字出现在它声称的节点 SQL 里？不存在就是未锚定，直接判不通过，不要替它找位置。',
      '2. **这条边/这个字段真的在图上吗？** 声称的 from -> to 必须在节点的 inputs/outputs 里；声称的字段必须在该表 schema 里。血缘图上没有的边，原文再像也不算。',
      '3. **原文证明了这条结论吗？** 即使两问都通过，也要判断它是否真的支持「这是一个问题」。原文只能说明现象，不能自动证明缺陷。',
      '只做这三件事。不要补充新发现，不要重写这条发现的措辞，不要因为「整体看起来还行」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '本领域是 recall-first：**只删除被证据正面否定的发现**（原文不存在、图里没有这条边、字段不在 schema 里）。证据不足不是删除理由，标为 undecided 交人工。',
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
      '允许的结论只有三种：`keep`（证据正面支持或未被否定）、`drop`（被证据正面否定）、`undecided`（存疑，交人工）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为「这条边看起来应该存在」就补上图上没有的边。',
      '- 不可以在原文与行号矛盾时「折中」：矛盾即未锚定。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。)'
        : findings.map((finding, index) => [
          `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称位置：${finding?.path ?? '(未给出)'}`,
          `- 声称的边/字段：${finding?.from !== undefined || finding?.to !== undefined
            ? `${String(finding?.from ?? '?')} -> ${String(finding?.to ?? '?')}`
            : (finding?.table !== undefined ? `${String(finding?.table)}.${String(finding?.column ?? '?')}` : '(未给出)')}`,
          `- 抄写原文：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原文即为未锚定)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
          `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（原文不存在 / 图里没有这条边 / 字段不在 schema 里），recall-first 下不得以「证据不足」为由删除。',
    ].join('\n')

    return { system, instructions }
  },
})
