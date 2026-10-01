/**
 * risk-compliance — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT
 * enforce that — `validateReviewPrompts` and `validateDomainPackV2` both return
 * `[]` for identical prompts — so an identical pair would sail through the
 * completion gate while quietly deleting the P6 layer. A reviewer "independently
 * re-checking" its own reasoning is not an independent re-check. The domain's
 * `test.mjs` asserts the difference, and `verify()` is built so it CANNOT see
 * the P4 reasoning: it receives findings, never the review transcript.
 *
 * THE ORIENTATION SENTENCE IS THE DOMAIN'S MOST IMPORTANT LINE
 * -----------------------------------------------------------
 * recall-first means: KEEP the doubtful item, LABEL it for human confirmation,
 * and drop it only when the evidence POSITIVELY disproves it. The prompt says
 * this to the model in both roles, because a model that believes a compliance
 * reviewer should be "careful not to over-report" will silently delete exactly
 * the findings this domain exists to surface.
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will
 * assert them as law.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'recall-first': '本领域的损失取向是 **recall-first**：漏报比误报贵得多。**存疑即保留**，标记为「待人工确认」；只有被证据**正面否定**时才删除。不确定不是删除的理由，只是标注的理由。',
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
})

/**
 * The dual-anchor law. Both halves are mandatory, and both prompt roles repeat
 * it — a reviewer that never learned the rule cannot honour it.
 */
const DUAL_ANCHOR_LAW = [
  '双锚点铁律：每条发现必须同时给出 **条款 ID** 与 **逐字抄写的证据原文**，缺一即判未锚定。',
  '**永远不要输出行号**。抄写你想引用的原文（含标点、括号、引号、缩进），引擎用滑窗自行定位。',
  '只忽略缩进差异；标点与标识符必须逐字一致。你写的是转述，引擎就会判定未锚定。',
  '条款 ID 必须是条款清单里真实存在的 ID。清单里没有的 ID 不是「更合适的条款」，是未锚定。',
  '未锚定的发现不计入覆盖率、不能作为结论使用。它不会因为你确信而变成有效的。',
  '给不出条款依据时，正确的动作是标记为「待定条款」并保留待人工确认 —— 不是丢弃，也不是编一个 ID。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '风控合规监察'}（${domain?.id ?? 'risk-compliance'}）`
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
   * P4 — the bounded review pass.
   * Receives the clause rules, the bundle's surfaces and the run's budget; does
   * the judging.
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
      '你正在执行**一轮有界合规审查（P4）**。你只对本轮负责的受监管面负责；不确定的项按下面的取向处理，不要靠提高语气来弥补证据。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 本轮的锚点铁律（双锚点）',
      ...DUAL_ANCHOR_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '这些是经验清单草稿，不是已生效的法律意见，也不是已审定的合规标准。规则与眼前的材料冲突时，以材料为准并说明冲突；不要把自己的规则当作权威去断言。',
      rules === '' ? '(本轮没有匹配到规则：只按材料本身的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的受监管面：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行，检索 ≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 先取证再判断；取证不到就降级为「证据不足，待人工确认」，而不是提高语气或换一个更吓人的条款。',
      '- 每条发现给出：条款 ID、受监管面、逐字抄写的证据原文、为什么这构成问题、以及合规方可能如何抗辩（defended 的依据）。',
      '- 受保护主题（security / privacy / safety / data-loss / legal）的发现一律提出，不因证据弱而略过。',
      '',
      '## 输出',
      '只输出发现，不输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent triage re-check.
   *
   * Deliberately shaped so it cannot inherit the P4 reasoning: it is handed
   * findings (claims + their quoted text + their clause) and nothing else. It
   * may only ask whether the quoted text exists, whether the clause exists, and
   * whether the material POSITIVELY DISPROVES the claim. Anything else survives
   * and is labelled for human confirmation.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮审查的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
      '',
      '## 你的唯一职责',
      '对每条发现按顺序问三个问题：',
      '1. **条款存在吗？** 抄写的条款 ID 是否真的在条款清单里？不存在就是未锚定，直接判不通过，不要替它找最接近的条款。',
      '2. **原文存在吗？** 抄写的那段文字，是否逐字出现在它声称的受监管面材料里？不存在或位置不唯一就是未锚定，不要替它找位置。',
      '3. **证据正面否定了这条结论吗？** 只有当材料**明确地、正面地**证明「这件事不是问题」时，才允许删除。',
      '只做这三件事。不要补充新发现，不要重写这条发现的措辞，不要因为「整体看起来还行」而放行。',
      '',
      '## 锚点铁律（复核用）',
      '本领域用**双锚点**：条款 ID（规则侧）+ 逐字抄写的证据原文（受审侧）。你要核对的正是这两半 —— 任一半不成立，这条发现就是未锚定的。',
      '你**不需要**、也**不可以**自己去猜原文该在哪个位置；你只判断给出的原文与给出的条款在材料里成立不成立。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '删除的门槛是**正面否定**，不是「证据不足」。证据不足的项一律保留并标记 `undecided` / 待人工确认 —— 这正是本领域存在的意义。',
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
      '允许的结论只有三种：`keep`（证据正面支持）、`drop`（证据**正面否定**）、`undecided`（存疑 —— 保留并标记待人工确认，不是删除）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为「这条看起来不像违规」就删除；必须是材料正面否定了它。',
      '- 不可以在原文与声明位置矛盾时「折中」：矛盾即未锚定。',
      '- 不可以对受保护主题（security / privacy / safety / data-loss / legal）行使删除权 —— 这类项一律保留。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。)'
        : findings.map((finding, index) => [
          `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称条款：${finding?.clauseId ?? finding?.clause ?? '(未给出 —— 未给出条款即为未锚定)'}`,
          `- 声称受监管面：${finding?.path ?? '(未给出)'}`,
          `- 抄写原文：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原文即为未锚定)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
          `- 受保护主题：${finding?.subject ?? '(无)'}`,
          `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体的正面否定依据（「材料明确写着已删除且已同步下游」这类），**不允许**用「证据不足」「看不出来」「无法确认」作为删除理由 —— 那三种一律判 `undecided` 并保留。',
    ].join('\n')

    return { system, instructions }
  },
})
