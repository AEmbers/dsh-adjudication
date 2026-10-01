/**
 * ux-review — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT
 * enforce that — `validateReviewPrompts` and `validateDomainPackV2` both return
 * `[]` for identical prompts — so an identical pair would sail through the
 * completion gate while quietly deleting the P6 layer. The domain's `test.mjs`
 * asserts the difference, and `verify()` is built so it CANNOT see the P4
 * reasoning: it receives findings, never the review transcript.
 *
 * P4 (`review`)  — bounded, branch-scoped, rule-injected, allowed to reason.
 * P6 (`verify`)  — adversarial fact-check, forbidden to reason about taste,
 *                  allowed only to ask "does the flow prove this or not".
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will
 * assert them as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
})

/** The two-sided anchor law. Both roles repeat it. */
const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写你想引用的原文（含标点、括号、引号、缩进），引擎用滑窗自行定位。',
  '步骤侧锚点必须同时给出**分支 id** 与**步骤 id**。步骤在流程里存在、但不在你声称的那条分支上，就是未锚定。',
  '你写的是转述，引擎就会判定未锚定。只忽略缩进，标点与标识符必须逐字一致。',
  '未锚定的发现不计入覆盖率，不能作为结论使用 —— 它不会因为你确信而变成有效的。',
  '找不到可抄写的原文，说明你还没有证据。此时正确的动作是不提出，而不是编一个位置。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? 'UX 交互设计'}（${domain?.id ?? 'ux-review'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /** P4 — the bounded, branch-scoped review pass. */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界交互审查（P4）**。你只对**这一条分支上的这些步骤**负责，不评价其他分支，也不评价主观审美。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 本轮的锚点铁律（步骤侧 + 证据侧）',
      ...ANCHOR_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是审查的经验清单，不是不可质疑的权威。规则与眼前的设计稿冲突时，以设计稿为准并说明冲突；不要把用户体验偏好当成事实断言。',
      rules === '' ? '(本轮没有匹配到规则：只按流程与设计稿的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的分支：${bundle.key ?? '(未指明)'}`,
      `- 本轮负责的 (分支/步骤)：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行，检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 先取证再判断：先确认这个步骤在哪条分支上、它的 next/onError/onCancel 声明是什么，再下结论。',
      '- 每条发现给出：分支 id、步骤 id、逐字抄写的原文、用户会经历的具体后果、以及设计方可能如何抗辩（defended 的依据）。',
      '- 只谈「用户会遇到什么」，不谈「我觉得好不好看」。',
      '',
      '## 输出',
      '只输出发现，不输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent re-check.
   *
   * Handed findings (claims + their quoted text + their branch/step binding) and
   * nothing else. It may only ask whether the binding exists, whether the quoted
   * text exists, and whether that text proves a user-visible consequence.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮审查的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
      '',
      '## 你的唯一职责',
      '对每条发现按顺序问三个问题：',
      '1. **步骤侧锚点成立吗？** 分支与步骤的绑定是否真的存在于流程里？不成立就是未锚定，直接判不通过，不要替它换一条分支。',
      '2. **原文存在吗？** 抄写的那段文字，是否逐字出现在它声称的步骤材料里？不存在或位置不唯一就是未锚定，不要替它找位置。',
      '3. **原文证明了这条结论吗？** 即使原文存在，也要判断它是否真的说明了「用户会遇到什么问题」。原文只能说明现象，不能自动证明体验缺陷。',
      '只做这三件事。不要补充新发现，不要重写这条发现的措辞，不要因为「整体看起来还行」而放行。',
      '',
      '## 锚点铁律（复核用）',
      '本领域的锚点是**步骤侧 + 证据侧**两半：分支与步骤的绑定（引擎重算）+ 逐字抄写的原文（引擎重算）。任一半不成立，这条发现就是未锚定的。',
      '你**不可以**自己去猜原文该在哪个位置或这条发现该挂在哪条分支上。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
      '允许的结论只有三种：`keep`（证据正面支持）、`drop`（证据不足或与原文矛盾）、`undecided`（存疑，交由损失取向裁决）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为「这条设计确实不够优雅」就认可它：本领域判的是流程完备性与可恢复性，不是审美。',
      '- 不可以在原文与声明位置矛盾时「折中」：矛盾即未锚定。',
      '- 不可以把「用户可能困惑」当作事实：必须由原文里的具体流转或状态缺失支撑。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。)'
        : findings.map((finding, index) => [
          `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称分支：${finding?.branchId ?? '(未给出 —— 未给出分支即为未锚定)'}`,
          `- 声称步骤：${finding?.stepId ?? '(未给出 —— 未给出步骤即为未锚定)'}`,
          `- 声称材料：${finding?.path ?? '(未给出)'}`,
          `- 抄写原文：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原文即为未锚定)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
          `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（绑定不存在 / 原文不存在 / 原文与该结论无关 / 原文与声明位置矛盾）。',
    ].join('\n')

    return { system, instructions }
  },
})
