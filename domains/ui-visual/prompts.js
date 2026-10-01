/**
 * ui-visual — P4/P6 review prompts (contract v2, extension point 4).
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
 * THE SECOND THING: CONTRAST MUST BE A NUMBER
 * -------------------------------------------
 * The P4 prompt forbids qualitative contrast claims outright. A reviewer that
 * writes "contrast looks low" has produced something nobody can check; the
 * domain requires the computed ratio and the threshold it is measured against.
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
})

/** The three-sided anchor law. Both roles repeat it. */
const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写你想引用的原文（含标点、括号、引号、缩进），引擎用滑窗自行定位。',
  '图层侧锚点必须同时给出**图层 ID**、**属性名**与** token 名**三者之一都缺即判未锚定。引擎会到 token 表里核对这个 token 是否真的存在。',
  '引用一个 token 表里不存在的 token = 未锚定。它不会因为「听起来很合理」而被接受。',
  '你写的是转述，引擎就会判定未锚定。只忽略缩进，标点与标识符必须逐字一致。',
  '未锚定的发现不计入覆盖率，不能作为结论使用。',
]

const CONTRAST_LAW = [
  '**对比度必须是算出来的数字**：给出前景色、背景色、计算出的比值与所用阈值（正文 4.5:1，大字号 3:1）。',
  '「对比度偏低」「看起来不够清晰」这类定性描述在本领域**不是发现**，不得提出。',
  '比值必须来自 WCAG 2.x 相对亮度公式；需要时先调用取证工具 contrast_ratio 取得数值再下结论。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? 'UI 视觉设计'}（${domain?.id ?? 'ui-visual'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /** P4 — the bounded, component-scoped review pass. */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界设计系统审查（P4）**。你只对**这个组件的这些属性**负责，不评论其他组件，也不评论主观审美。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 本轮的锚点铁律（图层侧 + token 侧 + 证据侧）',
      ...ANCHOR_LAW,
      '',
      '## 对比度铁律',
      ...CONTRAST_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是设计系统的经验清单草稿，不是不可质疑的权威。规则与 token 表冲突时，以 token 表为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按 token 表与图层属性的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的组件：${bundle.key ?? '(未指明)'}`,
      `- 本轮负责的 (图层/属性)：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 先查 token 表再下结论：这个值对应哪个 token、该 token 是否存在、该属性是否已经声明了 tokenRef。',
      '- 每条发现给出：图层 ID、属性名、当前值、应为的 token 名、逐字抄写的原文、以及设计方可能如何抗辩（defended 的依据）。',
      '',
      '## 输出',
      '只输出发现，不输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent re-check.
   *
   * Handed findings (claims + their quoted text + their layer/prop/token triple)
   * and nothing else. It may only ask whether the layer/prop/token triple
   * recomputes, whether the quoted text exists, and whether that text proves a
   * design-system deviation. It is explicitly told NOT to substitute its own
   * taste for a missing ratio.
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
      '对每条发现按顺序问四个问题：',
      '1. **图层与属性存在吗？** 该图层是否存在、该属性是否存在、该属性是否已经声明了 tokenRef？任何一项不成立就是未锚定。',
      '2. **token 存在吗？** 抄写的 token 名，是否真的在 token 表里？不存在就是未锚定，不要替它找一个近似的 token 名。',
      '3. **原文存在吗？** 抄写的那段文字，是否逐字出现在它声称的图层材料里？不存在或位置不唯一就是未锚定。',
      '4. **原文证明了这条结论吗？** 即使原文存在，也要判断它是否真的说明了一个设计系统偏离。',
      '只做这四件事。不要补充新发现，不要重写这条发现的措辞，不要因为「整体看起来还行」而放行。',
      '',
      '## 对比度类的额外要求',
      '对比度类发现**必须**带有计算出的比值与阈值。「对比度偏低」这类定性描述一律不通过 —— 没有数字就没有结论。',
      '',
      '## 锚点铁律（复核用）',
      '本领域的锚点是**图层侧 + token 侧 + 证据侧**三部分，全部由引擎重算：图层存在、属性存在且未声明 tokenRef、token 名存在、原文逐字命中。任一项不成立，这条发现就是未锚定的。',
      '你**不可以**自己去猜这个值应该对应哪个 token。',
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
      '- 不可以用自己的审美替代缺失的比值：缺数字即不通过，不允许「我目测大概 3:1」。',
      '- 不可以在原文与声明位置矛盾时「折中」：矛盾即未锚定。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。)'
        : findings.map((finding, index) => [
          `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称图层：${finding?.layerId ?? '(未给出 —— 未给出图层即为未锚定)'}`,
          `- 声称属性：${finding?.prop ?? '(未给出 —— 未给出属性即为未锚定)'}`,
          `- 声称 token：${finding?.tokenName ?? '(未给出 —— 未给出 token 即为未锚定)'}`,
          `- 声称材料：${finding?.path ?? '(未给出)'}`,
          `- 抄写原文：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原文即为未锚定)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
          `- 计算出的对比度比值：${finding?.ratio ?? '(未给出 —— 对比度类发现缺比值即不通过)'}`,
          `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（图层/属性不存在、token 不存在、属性已声明 tokenRef、原文不存在、原文与该结论无关）。',
    ].join('\n')

    return { system, instructions }
  },
})
