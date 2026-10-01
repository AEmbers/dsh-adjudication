/**
 * tech-doc — P4/P6 review prompts (contract v2, extension point 4).
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
 * PRECISION-FIRST IS STATED IN BOTH, BECAUSE IT CHANGES THE INSTRUCTION
 * --------------------------------------------------------------------
 * A documentation complaint that the source cannot disprove is worse than no
 * complaint: it costs a maintainer a real edit to chase a style preference. So a
 * finding must name the source-side verification point, and P6 may only keep a
 * finding whose drift the API surface or the document structure POSITIVELY
 * demonstrates. "I think this looks off" is not a finding in this domain.
 *
 * HONESTY: the injected rule text is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so, because a
 * reviewer that believes its unchecked rules are authoritative will assert them
 * as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。文档与源码的差异**必须能被源码证明**；证不出来就不要提出。',
  'recall-first': '本领域的损失取向是 recall-first：漏掉的一致性问题代价更高。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
})

const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写文档里那一行（含标点、参数、类型注解），引擎用滑窗自行定位。',
  '签名类断言必须逐字抄写**整个签名**：函数名、参数表、返回类型注解。少一个参数或改一处类型，引擎就会判定签名与 API surface 不一致。',
  '只忽略缩进与空白的差异，标点与标识符必须逐字一致。你写的是转述，引擎就会判定未锚定。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '技术文档'}（${domain?.id ?? 'tech-doc'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /** P4 — the bounded review pass over one document's verifiable claims. */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界的文档一致性评审（P4）**。你评审的是「文档写的东西和实现是否一致」，不是文笔、排版、语气或完整性建议。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 本轮的锚点铁律',
      ...ANCHOR_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是评审的经验清单，不是不可质疑的权威。规则与眼前的证据冲突时，以证据为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按文档原文与 API surface 判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的路径：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行，检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 下结论前先取证：api_lookup 拿到源码侧签名，read_section 拿到文档侧原文。',
      '- 每条发现给出：文档路径与段落锚、抄写的原文、源码侧的验证点（API 名，或段落锚）、以及为什么这算不一致。',
      '- 只有「签名 / 参数 / 返回值 / 示例 / 链接」这几类可机械核验的东西才算发现；',
      '  「文档可以写得更清楚」这类建议不属于本领域，不要提出。',
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
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮文档评审的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问两个问题，按顺序：',
      '1. **原文存在吗？** 抄写的那段文档原文，是否逐字出现在它声称的段落里？不存在就是未锚定，直接判未通过，不要替它找位置。',
      '2. **源码侧证明得了吗？** 这条发现声称的差异，能否由 API surface 或文档结构**正面证明**？证明不了（例如「文档没提这个限制」而源码里也找不到该限制）就不成立。',
      '只做这两件事。不要补充新发现，不要重写措辞，不要因为「整体看起来还行」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
      '允许的结论只有三种：`keep`（源码侧正面证明）、`drop`（**证据正面否定**：原文不存在、签名与 API surface 逐字一致、参数表与源码一致）、`undecided`（存疑）。',
      'precision-first 下 `undecided` **按 drop 处理**：补不出源码侧证据的文档建议，不值得让维护者去改。',
      '',
      '## 你不可以做的事',
      '- 不可以把「我不知道这个 API」当成「文档写错了」。查不到意味着**不知道**，不是证据。',
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
      '判 `drop` 时必须引用**正面否定**的具体依据（原文不存在 / 签名逐字一致 / 参数表一致）。',
      '判 `undecided` 时必须说明缺哪一项证据才能定论。',
    ].join('\n')

    return { system, instructions }
  },
})
