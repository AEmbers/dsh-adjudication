/**
 * operator-design — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT
 * enforce that — `validateReviewPrompts` and `validateDomainPackV2` both return
 * `[]` for identical prompts — so an identical pair would pass the completion
 * gate while quietly deleting the P6 layer. The domain's `test.mjs` asserts the
 * difference, and `verify()` is shaped so it CANNOT see the P4 reasoning: it
 * receives findings, never the review transcript.
 *
 * RECALL-FIRST IS STATED IN BOTH, BECAUSE IT CHANGES THE INSTRUCTION
 * -----------------------------------------------------------------
 * An operator form with no numeric test does not fail until someone calls it on
 * that backend, dtype or shape — usually in production, usually with a wrong
 * answer rather than a crash. So P4 must not silently drop a form it cannot
 * fully rule out, and P6 may only remove a finding whose gap the test manifest
 * POSITIVELY DISPROVES (a matching, tolerance-asserting test exists). "I did not
 * find a test" is not a disproof — for this domain it is usually the finding.
 *
 * HONESTY: the injected rule text is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so, because a
 * reviewer that believes its unchecked rules are authoritative will assert them
 * as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
  'recall-first': '本领域的损失取向是 recall-first：一个没有数值测试的形态直到被人调用才会暴露，而那时它给的是错答案而不是崩溃。存疑即保留并标注为待人工确认；**只有被测试清单正面否定时才删除**。「我没找到测试」不是否定。',
})

const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写实现里那一行（含分号、括号、const、引用符），引擎用滑窗自行定位。',
  '你抄的那一行必须**真的落在该形态的实现里**：如果测试清单里已经有覆盖该形态的测试，你的「未覆盖」主张就被清单正面否定了 —— 锚点会判未锚定。',
  '每条发现必须点名完整的形态四元组：算子名、后端、dtype、shape 分支。缺一个，锚点就无法重算，整条发现只能判未锚定。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '算子设计'}（${domain?.id ?? 'operator-design'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /** P4 — the bounded review pass over one operator's forms. */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界的算子评审（P4）**。你评审的是「这个形态有没有被数值验证过、数值行为在边界上是否成立」，不是代码风格，也不是性能。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 本轮的锚点铁律',
      ...ANCHOR_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是评审的经验清单，不是不可质疑的权威。规则与眼前的证据冲突时，以证据为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按注册表与测试清单判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的路径：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行，检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 下结论前先取证：coverage_matrix 看形态有没有测试，tolerance_lookup 看容差到底断言了什么，read_kernel 看实现在那段里做了什么。',
      '- 每条发现给出：算子名与四元组形态、抄写的原文、测试清单里与该形态相关的条目、以及为什么这构成缺口。',
      '- 两类缺口都算发现：**完全没有测试的形态**（更严重），以及**有测试但没断言容差**的形态。',
      '',
      '## 输出',
      '只输出发现，不输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent re-check, shaped so it cannot inherit P4's reasoning.
   *
   * It is handed findings (claims + their quoted text) and nothing else: no
   * rules, no work order, no P4 transcript.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮算子评审的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问两个问题，按顺序：',
      '1. **原文存在吗？** 抄写的那段实现原文，是否逐字出现在它声称的文件里？不存在就是未锚定，直接判未通过，不要替它找位置。',
      '2. **测试清单否定了它吗？** 如果清单里有覆盖该形态且**断言了可用容差**的测试，那么「未覆盖 / 没容差」的主张被正面否定，可以删除。',
      '只做这两件事。不要补充新发现，不要重写措辞，不要因为「整体看起来还行」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
      '允许的结论只有三种：`keep`（清单正面支持「该形态无测试/无容差」）、`drop`（**证据正面否定**：原文不存在，或清单里有覆盖该形态且断言了容差的测试）、`undecided`（存疑）。',
      'recall-first 下 `undecided` **保留**并标注待人工确认 —— 不得因为「测试清单里查不到」而当作已覆盖。',
      '',
      '## 你不可以做的事',
      '- 不可以把「清单里没有这个形态的条目」当成「已经覆盖」。查不到意味着**不知道**，不知道要保留。',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
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
      '判 `drop` 时必须引用**正面否定**的具体依据（原文不存在 / 清单里有带容差的覆盖测试）。',
      '判 `undecided` 时必须说明缺哪一项证据才能定论。',
    ].join('\n')

    return { system, instructions }
  },
})
