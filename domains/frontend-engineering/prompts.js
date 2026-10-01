/**
 * frontend-engineering — P4/P6 review prompts (contract v2, extension point 4).
 *
 * Same anchor law as code-review (it IS the same verifier, so the instruction
 * must be the same), different review order: rendering correctness, async races,
 * accessibility, bundle cost. The last one is only answerable because the
 * candidate carries `chunkBytes` — and the prompt says what to do when it does
 * not (say "unknown", never "no impact").
 *
 * P4 and P6 are different documents. The contract validators do not check that,
 * so the domain's `test.mjs` does.
 *
 * HONESTY: rules are agent-drafted with `needs-expert-review: true`; both
 * prompts state it to the model.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注；只有被证据正面否定时才删除。',
})

const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写你想评论的新增行（含分号、括号、引号、JSX 标签），引擎用与代码评审相同的滑窗定位。',
  '只忽略缩进与 diff 标记的差异，标点与标识符必须逐字一致。你写的是转述，引擎就会判定未锚定。',
  '未锚定的发现不计入覆盖率 —— 它不会因为你确信而变成有效的。',
  '找不到可抄写的原文，说明你还没有证据。此时正确的动作是不提出，而不是编一个位置。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '前端工程'}（${domain?.id ?? 'frontend-engineering'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界客户端评审（P4）**。只对本次变更引入或改变的问题负责；既有代码的既有问题不算。',
      '',
      '## 本领域的审查顺序',
      '1. **渲染正确性**：副作用是否在渲染期执行；依赖数组是否完整；是否以每次新建的对象/函数作为依赖；列表 key 是否稳定。',
      '2. **异步竞态**：是否假设了请求返回顺序；组件卸载后是否还会写状态；是否有真正的取消而不是「忽略结果」。',
      '3. **可访问性**：可交互元素是否语义正确（div 当按钮用即为问题）；键盘可达与可见焦点；图片替代文本。',
      '4. **体积成本**：候选上带着 bundle 体积数据时引用它；**没有数据就说「未知」**，不得断言「不影响首屏」。',
      '跨端/跨浏览器行为只有在你抄写的原文本身能证明时才说；否则标注为需要验证。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 锚点铁律',
      ...ANCHOR_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是经验清单，不是不可质疑的权威。规则与眼前的代码冲突时，以代码为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按变更本身的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的路径：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行，检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 想知道某个 JSX 行属于哪个组件时用 render_scope；它找不到作用域时会明说「未知」，那份未知要保留到结论里。',
      '',
      '## 输出',
      '只输出发现，不输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮评审的作者。你**看不到**上一轮的推理过程、语气与自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问两个问题，按顺序：',
      '1. **原文存在吗？** 抄写的那段 JSX/CSS/TS，是否逐字出现在它声称的文件里？不存在就是未锚定，直接判不通过，不要替它找位置。',
      '2. **原文证明了这条结论吗？** 即使原文存在，也要判断它是否真的支持「这是一个问题」。一段代码只能说明现象，不能自动证明缺陷。',
      '只做这两件事。不要补充新发现，不要重写措辞，不要因为「整体看起来还行」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
      '允许的结论只有三种：`keep`（证据正面支持）、`drop`（证据不足或与原文矛盾）、`undecided`（存疑，交由损失取向裁决）。',
      '对「体积成本」类发现额外问一句：体积数据从哪来？没有数据就是未知，未知不得当作「没有影响」放行，也不得当作「有影响」保留。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为找到了这条发现、就顺手认可它的严重度或修复建议。',
      '- 不可以在原文与行号矛盾时「折中」：矛盾即未锚定。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。)'
        : findings.map((finding, index) => [
          `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称位置：${finding?.path ?? '(未给出)'}`,
          `- 抄写原文：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原文即为未锚定)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
          `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（原文不存在 / 原文与该结论无关 / 原文与声明位置矛盾）。',
    ].join('\n')

    return { system, instructions }
  },
})
