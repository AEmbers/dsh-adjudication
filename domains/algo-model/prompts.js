/**
 * algo-model — P4/P6 review prompts (contract v2, extension point 4).
 *
 * `review()` and `verify()` must not be the same text. The validators do NOT
 * enforce that, which is why this domain's `test.mjs` asserts
 * `assert.notEqual(p6.system, p4.system)`: a P6 prompt identical to P4 deletes
 * the independent re-check while still passing every gate.
 *
 * P4 (`review`)  — bounded, rule-injected, reasons about the experiment.
 * P6 (`verify`)  — adversarial triage that CANNOT see the P4 reasoning: it is
 *                  handed findings, and may only ask "does this metric line
 *                  exist in that experiment, and does the record agree".
 *
 * HONESTY: the injected rule text is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will
 * assert them as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
})

const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写你依据的那一行实验记录（`metric <名字> = <值>`），引擎用滑窗自行定位。',
  '指标铁律：每条发现必须同时给出**实验 ID 与指标名**。指标名必须在它被归属的那个实验里存在 —— 别的实验有同名指标不算。',
  '数字铁律：引用数值时必须与记录逐字一致，不做四舍五入、不做单位换算、不补有效位。',
  '口径铁律：跨实验比较任何指标之前，先确认两边的 definition 相同；口径不同就先说口径，不要比数字。',
  '只忽略缩进与 diff 标记的差异，标点与标识符必须逐字一致。你写的是转述，引擎就会判定未锚定。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '算法模型'}（${domain?.id ?? 'algo-model'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /** P4 — the bounded review pass over one experiment. */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界算法实验复核（P4）**：一个实验记录。只对本轮这个实验负责。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 本轮的铁律',
      ...ANCHOR_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是经验清单，不是不可质疑的权威。规则与眼前的记录冲突时，以记录为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按实验记录的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 本领域的核心风险：逐题复核',
      '- **单题分数高不等于整体好转**：必须在逐题（逐指标）层面看，任何「总体提升」的结论都要给出它覆盖了哪些指标、漏了哪些。',
      '- 没有 baseline 的实验不能作为「有提升」的证据；baseline 没有同名指标时，差值不存在，不是 0。',
      '- 指标定义漂移（同名不同定义）、测试集泄漏（train/test 同源、tune 在 test 上做过选择）、显著性缺失（单次运行、无方差/置信区间）、口径不一致（微平均/宏平均、是否含 padding、阈值选择）都是本领域的典型失败模式。',
      '- 选择偏差：用 test 选超参、用多次运行里的最好一次、只报提升的指标。',
      '',
      '## 工作方式',
      `- 本轮负责的路径：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行，检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 用 experiment_card / metric_delta / definition_compare 取证后再判断；取证不到就降级为「证据不足」，而不是提高语气。',
      '- 每条发现给出：path、实验 ID、指标名、抄写的原文、你判断它为什么是问题、以及反方可能怎么说（defended 的依据）。',
      '',
      '## 输出',
      '只输出发现，不输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent triage. It cannot see the P4 reasoning: it receives
   * findings (claims + their quoted text), never the transcript or the rules.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮复核的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问四个问题，按顺序：',
      '1. **原文存在吗？** 抄写的那一行，是否逐字出现在它声称的实验记录卡里？不存在就是未锚定，直接判不通过，不要替它找位置，也不要自己推算行号 —— 行号由引擎重算。',
      '2. **这个实验真的有这个指标吗？** 指标名必须出现在被归属的那个实验里；别的实验有同名指标不算。',
      '3. **数字对得上吗？** 引用的数值与记录不符（四舍五入、单位换算、补有效位）即是未锚定。',
      '4. **口径对得上吗？** 跨实验比较时，两边 definition 不同即口径不一致，该结论不成立。',
      '只做这四件事。不要补充新发现，不要重写这条发现的措辞，不要因为「整体看起来还行」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '本领域是 recall-first：**只删除被证据正面否定的发现**（原文不存在、该实验没有这个指标、数字/口径与记录矛盾）。证据不足不是删除理由，标为 undecided 交人工。',
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
      '允许的结论只有三种：`keep`（证据正面支持或未被否定）、`drop`（被证据正面否定）、`undecided`（存疑，交人工）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为「这个指标看起来应该提升」就替它补一个数字。',
      '- 不可以只看总体指标就放过逐题层面的漏报。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。)'
        : findings.map((finding, index) => [
          `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称位置：${finding?.path ?? '(未给出)'}`,
          `- 声称的实验/指标：${finding?.experimentId ?? '(未给出)'} / ${finding?.metricName ?? '(未给出)'}`,
          `- 抄写原文：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原文即为未锚定)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
          `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（原文不存在 / 该实验没有这个指标 / 数字或口径与记录矛盾），recall-first 下不得以「证据不足」为由删除。',
    ].join('\n')

    return { system, instructions }
  },
})
