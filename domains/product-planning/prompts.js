/**
 * product-planning — P4/P6 review prompts (contract v2, extension point 4).
 *
 * P4 (`review`)  — the constrained planner: drafts plan items and hangs every one
 *                  of them on a requirement id + its verbatim title, plus a
 *                  metric someone actually declared.
 * P6 (`verify`)  — the adversarial re-check: it sees claims, never the P4
 *                  transcript. Its job is deletion, and this domain is
 *                  precision-first, so deletion is the DEFAULT for anything the
 *                  material does not prove. That is the loss orientation doing
 *                  its work, and it is stated to the model in both roles.
 *
 * The two texts must differ; the contract's validators do not enforce it, so the
 * domain's `test.mjs` does (`assert.notEqual(p6.system, p4.system)`).
 *
 * HONESTY: the injected rules are agent-drafted and carry
 * `needs-expert-review: true`. Both prompts say so.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**删除**（或标注为待决策项），不要保留。',
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注；只有被材料正面否定时才删除。',
})

const TRACE_LAW = [
  '可追溯铁律：每条方案项必须挂回一条**需求库中真实存在**的需求，并逐字抄写该需求的原文（标题）。转述的需求不算需求。',
  '指标必须由方案自己声明。说「提升转化率」但没有人声明过这个指标、没有基线、没有时间窗，就不是可度量的目标。',
  '挂不上需求的功能不叫方案项，叫**范围蔓延**。它必须单独列为「无来源」，不得丢弃，也不得伪装成有来源。',
  '需求库里没有的 ID 一律不算追溯：ID 写错、指向已删除的需求，都是断链。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '产品规划经理'}（${domain?.id ?? 'product-planning'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /** P4 — bounded plan drafting + review over one bundle of requirement↔plan edges. */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界方案编排与审定（P4）**，对象是「方案承接需求」的边。两段结构是硬性的：**先编排、后审定**，且都发生在这一轮有界回路里。',
      '',
      '## 第一段：受约束的编排器',
      '- 为每条边给出：requirementId、逐字抄写的需求原文、planId、目标指标（名称 + 基线 + 目标值 + 时间窗）、以及它所依赖的前置条件。',
      '- 指标只能取材料中**已经声明**的；材料里没有声明的指标名，不要自己发明一个。',
      '- 没有需求来源的功能项、顺手做的改动，一律进「无来源」清单，不进方案。',
      '',
      '## 第二段：审定型回路',
      '- 逐条回问：这条需求真的被这个方案承接了吗？还是只是被提到了？',
      '- 未承接的需求（需求侧孤儿）与不承接需求的方案（方案侧孤儿）都要写出，它们是本领域的主要发现。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 可追溯铁律',
      ...TRACE_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是经验清单，不是不可质疑的权威。规则与眼前的材料冲突时，以材料为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按材料本身的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的边：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：一次最多列 ${budget.maxSearchHits ?? 40} 条孤儿/指标，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 指标有没有基线、需求在不在库里，都要先取证再判断；取证不到就写成「待决策」，不要写成已决策。',
      '',
      '## 输出',
      '输出方案项与孤儿清单。允许输出空列表 —— 但空列表必须说明为什么没有可编排的内容。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent re-check. Findings only: no rule text, no budget, no
   * work order, and therefore no P4 reasoning to argue with.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这一轮编排的作者。你**看不到**它的推理、语气与自述，只看到它交回的方案项。这是刻意的：看不到推理，你才只能核对事实。',
      '',
      '## 你的唯一职责',
      '对每条方案项只问三个问题，按顺序：',
      '1. **需求 ID 真的在库里吗？** 断链直接判不通过，不要替它找一个「可能是」的需求。',
      '2. **抄写的需求原文逐字对得上吗？** 对不上就是未锚定；转述过的「需求」不接受。',
      '3. **指标真的是这个方案声明的吗？有基线、有目标值、有时间窗吗？** 缺任何一项，这条目标就不成立。',
      '只做这三件事。不要补充新方案项，不要重写措辞，不要因为「整体方向对」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '在这个取向下，**删除是默认**：材料证明不了的方案项不进结论，被删的项写清「缺什么证据」。未承接的需求与不承接需求的方案必须写进结论，它们不因「看起来不重要」被删。',
      '',
      '## 反方义务',
      '对每条方案项，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算材料正面支持它。',
      '允许的结论只有三种：`keep`（需求在库、原文逐字对得上、指标齐备）、`drop`（断链 / 原文不符 / 指标缺项）、`undecided`（存疑，交由损失取向裁决）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为方案写得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为需求存在，就顺手认可它被满足的程度或指标的合理性。',
      '- 不可以在需求 ID 与原文矛盾时「折中」：矛盾即未锚定。',
      '',
      '## 待复核的方案项',
      findings.length === 0
        ? '(空集：没有方案项需要复核。空集不是失败，也不要为它编造一条。)'
        : findings.map((finding, index) => [
          `### 方案项 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称承接的需求：${finding?.requirementId ?? '(未给出 —— 未给出需求 ID 即为无来源)'}`,
          `- 抄写需求原文：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原文即为未锚定)'}`,
          `- 声明的指标：${finding?.metricName ?? '(未声明)'}　基线：${finding?.baseline ?? '(未给出)'}　目标：${finding?.target ?? '(未给出)'}　时间窗：${finding?.window ?? '(未给出)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（需求 ID 不在库 / 原文不符 / 指标未声明或缺基线）。',
      '指标缺项的方案项即使需求追溯完整，也要 `drop` 并写明缺的是哪一项。',
    ].join('\n')

    return { system, instructions }
  },
})
