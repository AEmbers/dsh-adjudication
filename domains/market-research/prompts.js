/**
 * market-research — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT
 * enforce that, so an identical pair would sail through the completion gate while
 * quietly deleting the P6 layer: a reviewer "independently re-checking" its own
 * reasoning is not an independent re-check. This domain's `test.mjs` asserts the
 * difference, and `verify()` is built so it CANNOT see the P4 reasoning — it
 * receives findings, never the review transcript or the rules.
 *
 * BOTH PROMPTS STATE THE DOMAIN'S COST MODEL, because it changes what the model
 * is allowed to conclude:
 *
 *   候选集不可先验枚举、成本无上界。
 *
 * A market-research review is not finished at the end of a file list; it is
 * finished when the reviewer stops paying. A model that believes it has seen the
 * whole market will state a bounded coverage claim that the evidence cannot
 * support — so the prompt forbids that sentence explicitly, in both roles.
 *
 * BOTH PROMPTS ALSO STATE THE EVIDENCE LAW: 一手 / 二手 / 推测.  A finding that
 * rests on a 二手 source and presents itself as 一手 is refused by the verifier
 * before its quotation is even read, so the model is told that up front.
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
  '锚点铁律：**永远不要输出行号**。逐字抄写依据的那一行（含标点、数字、引号、单位），引擎用滑窗自行定位；不要自己推算行号。',
  '证据强度铁律：每条发现必须标注它依据的来源是**一手 / 二手 / 推测**中的哪一种，且不得高于来源本身的强度。把二手来源的结论按一手引用，锚点复核会直接拒绝。',
  '引文铁律：你写的是转述，引擎就判定未锚定。只忽略空白与缩进差异，标点、数字、实体名必须逐字一致。',
  '成本铁律：候选集不可先验枚举、成本无上界。不要写「已覆盖整个市场」「已查完所有竞品」这类话 —— 你看到的只是 seed 里已知的来源，不是市场的边界。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '市场调研'}（${domain?.id ?? 'market-research'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText !== 'string' || ruleText.trim() === '') {
    return ['## 本轮注入的规则', '（本轮没有匹配到规则：按上面的铁律与下面的一般性要求执行）', '']
  }
  return [
    '## 本轮注入的规则（agent 起草、needs-expert-review，**不是专家审定过的标准**）',
    '这些规则是草稿，用于提示检查方向。引用它们时不要把它们当成权威结论，也不要在报告里写成「按行业标准」。',
    '',
    ruleText,
    '',
  ]
}

function budgetBlock(context) {
  const budget = context?.budget ?? {}
  const maxExcerptLines = budget.maxExcerptLines ?? 500
  const maxToolCalls = budget.maxToolCalls ?? 100
  return [
    '## 本轮的读取边界',
    `- 单段证据摘录最多 ${maxExcerptLines} 行；`,
    `- 取证工具最多调用 ${maxToolCalls} 次；`,
    '- 超出边界的部分请标注「未读」，不要用推断填补未读的部分。',
    '',
  ]
}

function workOrder(context) {
  const bundle = context?.bundle ?? {}
  const paths = Array.isArray(bundle.paths) ? bundle.paths : (Array.isArray(context?.candidates) ? context.candidates : [])
  if (paths.length === 0) return ['## 本轮负责的来源', '（本轮没有准入的来源）', '']
  return [
    '## 本轮负责的来源',
    ...paths.map((path) => `- ${path}`),
    '',
  ]
}

/**
 * P4 — the bounded review. It sees the rules, the work order and the budget, and
 * it is deliberately the ONLY one of the two allowed to reason about what the
 * evidence means.
 */
export function review(context = {}) {
  const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
  const system = [
    domainHeading(context.pack ?? context.domain),
    '',
    '你是**市场调研的一轮评审者（P4）**。你只在本轮给定的来源范围内工作，只给出有逐字证据的意见。',
    '',
    '## 你在做什么',
    '对一个研究问题，检查已知来源与结论之间是否经得起推敲：结论是否比证据强、样本是否有代表性、时间窗与口径是否被悄悄换掉、单位与币种是否混用、是否把营销材料当成了市场事实。',
    '你**不是**在判断这个市场好不好，而是在判断这份调研的每一句话是否有它自己声称的那种证据。',
    '',
    '## 本领域特有的三条纪律',
    '1. **证据强度必须逐条标注**：一手（官方文件、原始数据、第一手访谈）/ 二手（媒体报道、行业报告转述）/ 推测（论坛帖、个人推断、供应商营销）。标注缺失时按「推测」处理，不要向上猜。',
    '2. **结论不得强于来源**：二手来源只能支撑「据报道」级别的说法；要下强结论，必须指出独立来源的第二条证据。',
    '3. **候选集不可先验枚举、成本无上界**：你看到的是 seed 里已知的来源。可以指出「还缺某类来源」，但不得声称覆盖已经完整。',
    '',
    ...ANCHOR_LAW,
    '',
    `## 本领域的损失取向：${orientation}`,
    ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
    '本领域是 recall-first：**只删除被证据正面否定的发现**。证据不足不是删除理由，标注为待人工确认即可。',
    '',
    ...ruleBlock(context),
    ...budgetBlock(context),
    ...workOrder(context),
    '## 输出要求',
    '每条发现给出：来源路径、逐字引文、依据的来源强度（一手/二手/推测）、这条发现为什么站得住、以及它**不算**什么（边界）。',
    '不要输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
  ].join('\n')

  const output = {
    system,
    instructions: '按「发现 + 逐字引文 + 证据强度 + 边界」逐条输出；没有有证据支持的发现时输出空列表。',
  }
  if (typeof context.ruleText === 'string' && context.ruleText.trim() !== '') output.rules = context.ruleText
  if (context.budget !== undefined && context.budget !== null) output.budget = context.budget
  return output
}

/**
 * P6 — the independent re-check. It is handed FINDINGS, never the review
 * transcript and never the rules: an adversarial reader that can see the
 * reasoning starts grading the reasoning instead of the facts.
 *
 * Its text is deliberately NOT the P4 text (see the header). The four questions
 * it asks are about existence, attribution, strength and wording — all
 * mechanical, none of which needs to know what the P4 reviewer intended.
 */
export function verify(context = {}) {
  const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
  const findings = Array.isArray(context.findings) ? context.findings : []

  const system = [
    domainHeading(context.pack ?? context.domain),
    '',
    '你是**独立复核者（P6）**，不是这轮调研的作者。你**看不到**上一轮的推理过程、规则注入和语气，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
    '',
    '## 你的唯一职责',
    '对每条发现只问四个问题，按顺序：',
    '1. **原文在吗？** 抄写的那一行，是否逐字出现在它声称的那份来源卡片里？不存在就是未锚定，直接判不通过，不要替它找位置，也不要自己推算行号。',
    '2. **强度标对了吗？** 标注为「一手」的来源，卡片上写的是一手吗？把二手来源按一手引用即是口径洗白，判不通过；未声明强度的来源按「推测」处理，把它当成一手或二手引用同样判不通过。',
    '3. **归属对吗？** 这句话真的来自它引用的那份来源吗？同一句话出现在多份卡片里时，这本身就是歧义，不要挑一份继续。',
    '4. **措辞强于证据吗？** 「据报道/据某供应商称」被写成了确定事实、数字被补了有效位、时间窗或口径被悄悄换掉，都判不通过。',
    '只做这四件事。不要补充新发现，不要重写措辞，不要因为「整体看起来合理」而放行。',
    '',
    '## 成本铁律',
    '候选集不可先验枚举、成本无上界。**不得**因为「已列出的来源都查过了」就判定覆盖完整；覆盖率的分母不是市场的边界。',
    '',
    `## 本领域的损失取向：${orientation}`,
    ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
    '本领域是 recall-first：只删除被证据正面否定的发现（原文不存在、强度标错、归属不符、措辞强于证据）。证据不足不是删除理由，标为 undecided 交人工。',
    '',
    '## 反方义务',
    '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
    '允许的结论只有三种：`keep`（证据正面支持或未被否定）、`drop`（被证据正面否定）、`undecided`（存疑，交人工）。',
    '',
    '## 你不可以做的事',
    '- 不可以因为来源看起来权威（大机构、知名媒体）就放行 —— 权威不是逐字证据。',
    '- 不可以因为「多个来源都这么说」就放行 —— 转述同一个原始来源不算两个来源，没查证之前不算印证。',
    '- 不可以把「未验证」当成「不成立」：未验证只是没查过，不是被否定。',
    '',
    '## 待复核的发现',
    findings.length === 0
      ? '（本轮没有任何发现。空集不是失败，也不代表市场没有问题 —— 只代表这一轮没有提出有证据支持的发现。）'
      : findings.map((finding, index) => {
        const path = finding?.path ?? '(未给出来源路径)'
        const strength = finding?.strength ?? '(未标注证据强度)'
        const evidence = String(finding?.evidence ?? finding?.excerpt ?? '').trim()
        return [
          `${index + 1}. [${finding?.id ?? '?'}] ${path}（声明强度：${strength}）`,
          `   主张：${String(finding?.message ?? '').trim()}`,
          `   引文：${evidence === '' ? '(未给出引文 —— 没有引文即无法锚定)' : evidence}`,
        ].join('\n')
      }),
  ].join('\n')

  return {
    system,
    instructions: '逐条给出 keep / drop / undecided 与最强反驳；不得新增发现，不得改写措辞，不得声称覆盖完整。',
  }
}

export default defineReviewPrompts({ review, verify })
