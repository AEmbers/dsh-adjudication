/**
 * requirement-research — P4/P6 review prompts (contract v2, extension point 4).
 *
 * `review()` and `verify()` must not be the same text. The contract validators
 * do NOT enforce that (`validateReviewPrompts` returns `[]` for identical
 * prompts), so the domain's own `test.mjs` asserts the difference — an
 * identical pair would pass every gate while quietly deleting the P6 layer.
 *
 * P4 (`review`)  — the bounded extractor/reviewer: recalls requirements and
 *                  hangs every one of them on a verbatim utterance.
 * P6 (`verify`)  — the independent re-check: it receives CLAIMS (statement +
 *                  quoted text + declared turn), never the P4 transcript, and
 *                  may only ask "does the corpus say this, and does it say
 *                  enough". It cannot see how confident P4 was.
 *
 * This domain is recall-first, so P6's shape is `triage`: it does not delete
 * what it cannot prove — it separates PROVEN from 存疑 and leaves the doubtful
 * ones standing for a human. That is the loss orientation, and it is stated to
 * the model in both roles.
 *
 * HONESTY: the injected rules are agent-drafted and marked
 * `needs-expert-review: true`. Both prompts say so, because a reviewer that
 * believes unchecked rules are authoritative will assert them as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'recall-first': '本领域的损失取向是 recall-first：漏掉一条真实诉求的代价高于多出一条噪音。存疑的条目**必须保留**并标注「待回访确认」；只有被语料正面否定的才删除。',
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
})

/** Both roles share these, because both are the model's obligations. */
const QUOTE_LAW = [
  '引用铁律：**抄写原话，不要转述**。原话必须逐字出现在语料里（只忽略空白差异）。改一个词、换一个语序、把口语整理成书面语，都是**另一句话**，引擎会判定未锚定。',
  '同时给出这句话的出处：场次 id 与第几句。句号是可核验的声明 —— 声明错了即判定未锚定，不会替你修正。',
  '候选是「原话」，不是「需求」。需求是加工产物，必须能挂回一句原话；挂不上的条目要单独列为「无来源」，**不得丢弃，也不得伪装成有来源**。',
  '语料里没有的话，就是没有证据。正确的动作是不提出，而不是把推断写成原话。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '需求调研分析'}（${domain?.id ?? 'requirement-research'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

export default defineReviewPrompts({
  /** P4 — bounded extraction + review over one bundle of utterance candidates. */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界需求抽取与审定（P4）**，对象是一批用户原话。两段结构的顺序是硬性的：**先抽取、后审定**，且每一步都留在同一个有界回路里。',
      '',
      '## 第一段：受约束的抽取器',
      '- 从原话里提出候选需求，每条给出：statement（一句话需求）、sourceQuote（逐字原话）、sourceTurn（场次 id + 第几句）、evidenceGrade（明说 / 行为暗示 / 推断）。',
      '- 「明说」与「推断」必须分开写。把推断写成用户明说，是本领域最严重的失败。',
      '- 抽取不设下限：一条原话可以提不出需求，这很正常。但**不许把两条原话合并成一条找不到出处的需求**。',
      '',
      '## 第二段：审定型回路',
      '- 逐条回问：这条原话真的支持这个 statement 吗？它支持的是这个需求，还是你希望它是这个需求？',
      '- 相互矛盾的原话必须**同时保留**并列写出，不得取平均、不得择一。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 引用铁律',
      ...QUOTE_LAW,
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是经验清单，不是不可质疑的权威。规则与眼前的语料冲突时，以语料为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按语料本身的事实判断，不要凭常识补规则。)' : rules,
      '',
      '## 工作方式',
      `- 本轮负责的候选：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次检索 ≤${budget.maxSearchHits ?? 60} 条命中，总调用 ≤${budget.maxToolCalls ?? 100} 次。`,
      '- 想引用一句原话但不确定它是否唯一时，先取证再引用；取证不到就降级为「存疑」，而不是提高语气。',
      '',
      '## 输出',
      '输出条目列表。可以输出空列表 —— 一批原话提不出需求是合法结论，但空列表要说明为什么。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — independent re-check. Handed claims and the corpus only; the P4
   * transcript, its budget and its rule text are deliberately absent.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这一轮抽取的作者。你**看不到**抽取时的推理、语气与自述，只看到它交回的条目本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对语料。',
      '',
      '## 你的唯一职责',
      '对每条条目只问三个问题，按顺序：',
      '1. **原话存在吗？** 抄写的那句话，是否逐字出现在它声明的场次与句号上？对不上就是未锚定，直接标 `undecided`，不要替它找位置。',
      '2. **原话支持这个需求吗？** 即使原话存在，也要判断它是「用户明说了这件事」，还是「作者从这句话推出了这件事」。后者只能标 `inferred`，不能标 `proven`。',
      '3. **它与其他原话冲突吗？** 冲突不是失败，是发现。冲突方必须并列保留。',
      '只做这三件事。不要补充新需求，不要润色原话，不要因为「整体看起来有道理」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '在这个取向下，「不确定」不是删除理由，而是标注理由：`undecided` 的条目仍然进结论，只是带着问号。',
      '',
      '## 反方义务',
      '对每条条目，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算语料正面支持它。',
      '允许的结论只有四种：`proven`（原话逐字存在且直接支持）、`inferred`（存在，但结论是加工产物）、`undecided`（存疑，交由损失取向裁决）、`drop`（原话不存在或与语料矛盾）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为条目写得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为原话存在，就顺手认可它支撑的需求范围、优先级或方案。',
      '- 不可以在原话与声明句号矛盾时「折中」：矛盾即未锚定。',
      '',
      '## 待复核的条目',
      findings.length === 0
        ? '(空集：没有条目需要复核。空集不是失败，也不要为它编造一条。)'
        : findings.map((finding, index) => [
          `### 条目 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称需求：${finding?.message ?? finding?.statement ?? '(未给出)'}`,
          `- 声称出处：${finding?.path ?? '(未给出)'}${finding?.turn === undefined ? '' : ` 第 ${finding.turn} 句`}`,
          `- 抄写原话：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出 —— 未给出原话即为未锚定)'}`,
          `- 作者自评的证据等级：${finding?.grade ?? '(未给出)'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `proven`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（原话不存在 / 原话与声明句号矛盾 / 原话与结论无关）。',
      '判 `inferred` 时写出：结论比原话多出来的那一部分是什么。',
    ].join('\n')

    return { system, instructions }
  },
})
