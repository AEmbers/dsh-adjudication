/**
 * reverse-engineering — P4/P6 review prompts (contract v2, extension point 4).
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
 * BOTH PROMPTS STATE THE DOMAIN'S TWO LAWS, because they change what the model is
 * allowed to conclude:
 *
 *   1. 候选集不可先验枚举、成本无上界 — a target artifact does not come with a
 *      list of the questions worth asking, so no report may claim the analysis is
 *      complete.
 *   2. 不可复现的推断必须标注为猜想 — "the blob is AES-128-CBC" is a hypothesis
 *      until someone writes down the steps that show it, and the two must never
 *      be presented as the same kind of statement. The verifier refuses a claim
 *      that upgrades one; the prompt says so before the model writes it.
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will
 * assert them as facts. Nothing in this domain is legal advice either: an
 * authorised-testing question is a question for a human, and both prompts say so.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'

const ORIENTATION_LINE = Object.freeze({
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
})

/** The invariants both prompts state, because both are the model's job to honour. */
const ANCHOR_LAW = [
  '锚点铁律：**永远不要输出行号**。逐字抄写依据的那一行（含偏移写法、标识符、十六进制大小写），引擎用滑窗自行定位；不要自己推算行号。',
  '样本铁律：每条结论必须绑定目标产物的 sha256。偏移、字符串表与补丁特征都会随样本变化，换一个样本结论就不成立。',
  '复现铁律：**不可复现的推断必须标注为猜想**。一个说法只有在步骤被写下来、别人照着能重现时，才能写成「观察 / 已验证」；否则只能写「推断 / 未验证」，并在结论里保留这个标注。',
  '成本铁律：候选集不可先验枚举、成本无上界。不要写「已经分析完这个产物」「没有其它可疑点」这类话 —— 你看到的只是 seed 里已经提出的观察。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '逆向工程'}（${domain?.id ?? 'reverse-engineering'}）`
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
  return [
    '## 本轮的读取边界',
    `- 单段证据摘录最多 ${budget.maxExcerptLines ?? 500} 行；`,
    `- 取证工具最多调用 ${budget.maxToolCalls ?? 100} 次；`,
    '- 超出边界的部分请标注「未读」，不要用推断填补未读的部分。',
    '',
  ]
}

function workOrder(context) {
  const bundle = context?.bundle ?? {}
  const paths = Array.isArray(bundle.paths) ? bundle.paths : (Array.isArray(context?.candidates) ? context.candidates : [])
  if (paths.length === 0) return ['## 本轮负责的线索', '（本轮没有准入的线索）', '']
  return ['## 本轮负责的线索', ...paths.map((path) => `- ${path}`), '']
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
    '你是**逆向工程的一轮评审者（P4）**。你只在本轮给定的线索范围内工作，只给出有逐字证据的意见。',
    '',
    '## 你在做什么',
    '检查这份逆向笔记里，每一条说法是不是「它自己声称的那种东西」：观察有没有可复现步骤、推断有没有保留猜想标注、结论有没有超出样本、补丁/校验/签名之类的判断有没有给出原始字节。',
    '你**不是**在判断攻击面或商业价值，而是在判断这些陈述经不经得起别人照着复现。',
    '',
    '## 本领域特有的三条纪律',
    '1. **观察与推断必须分开**：steps=0 或 verified=false 的陈述是猜想；把它写成观察、写进结论标题、或去掉限定语，都是本域最严重的失败模式。',
    '2. **结论必须绑定样本**：给出目标产物的 sha256（或明确指出它适用于哪个哈希的样本）。跨样本搬运偏移与特征一律不算。',
    '3. **候选集不可先验枚举、成本无上界**：你看到的是 seed 里已经提出的观察。可以指出「还缺哪一类观察」，但不得声称分析已经做完。',
    '涉及授权、法律或第三方系统边界的问题，**只能提出「需要人工确认」，不得自行断言合法性**。',
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
    '每条发现给出：线索笔记路径、逐字引文、这条陈述的类型（观察 / 推断）、样本哈希、它为什么站得住、以及它**不算**什么（边界）。',
    '不要输出行号。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论。',
  ].join('\n')

  const output = {
    system,
    instructions: '按「发现 + 逐字引文 + 陈述类型 + 样本哈希 + 边界」逐条输出；没有有证据支持的发现时输出空列表。',
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
 * it asks are mechanical: does the line exist, is it the same sample, was the
 * statement's reproduction status preserved, and does the wording claim more than
 * the steps support.
 */
export function verify(context = {}) {
  const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
  const findings = Array.isArray(context.findings) ? context.findings : []

  const system = [
    domainHeading(context.pack ?? context.domain),
    '',
    '你是**独立复核者（P6）**，不是这轮笔记的作者。你**看不到**上一轮的推理过程、规则注入和语气，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对事实。',
    '',
    '## 你的唯一职责',
    '对每条发现只问四个问题，按顺序：',
    '1. **原文在吗？** 抄写的那一行，是否逐字出现在它声称的那份线索笔记里？不存在就是未锚定，直接判不通过，不要替它找位置，也不要自己推算行号。',
    '2. **是同一个样本吗？** 结论绑定的 sha256 与登记的目标产物一致吗？不一致即结论不能成立（偏移与特征都会随样本变化）。',
    '3. **复现状态保留了吗？** 这条陈述在笔记里是 steps=0 或 verified=false 的**推断（猜想）**吗？把它写成「观察」「已验证」就是升级证据等级，判不通过。反之，把已复现的观察写成未验证，只是保守，不算缺陷。',
    '4. **措辞强于步骤吗？** 「可能是 / 看起来像」被写成确定结论、步骤数不足以支撑「已解密 / 已绕过」这类断言，都判不通过。',
    '只做这四件事。不要补充新发现，不要重写措辞，不要因为「整体看起来合理」而放行。涉及合法性与授权的断言一律标为 `undecided` 交人工，不做法律判断。',
    '',
    '## 成本铁律',
    '候选集不可先验枚举、成本无上界。**不得**因为「已列出的线索都看过了」就判定分析完整；覆盖率的分母不是这个产物的边界。',
    '',
    `## 本领域的损失取向：${orientation}`,
    ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
    '本领域是 recall-first：只删除被证据正面否定的发现（原文不存在、样本不符、证据等级被升级、措辞强于步骤）。证据不足不是删除理由，标为 undecided 交人工。',
    '',
    '## 反方义务',
    '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算证据正面支持它。',
    '允许的结论只有三种：`keep`（证据正面支持或未被否定）、`drop`（被证据正面否定）、`undecided`（存疑，交人工）。',
    '',
    '## 你不可以做的事',
    '- 不可以因为工具输出很长、反汇编看起来专业就放行 —— 篇幅不是证据。',
    '- 不可以替一条缺少步骤的推断补上「显然的」步骤。',
    '- 不可以把「未验证」当成「不成立」：未验证只是还没复现，不是被否定。',
    '',
    '## 待复核的发现',
    findings.length === 0
      ? '（本轮没有任何发现。空集不是失败，也不代表这个产物没有问题 —— 只代表这一轮没有提出有证据支持的发现。）'
      : findings.map((finding, index) => {
        const path = finding?.path ?? '(未给出线索笔记路径)'
        const sha = finding?.sha256 ?? '(未绑定样本哈希)'
        const status = finding?.verified === undefined ? '(未标注复现状态)' : `verified=${String(finding.verified)}`
        const evidence = String(finding?.evidence ?? finding?.excerpt ?? '').trim()
        return [
          `${index + 1}. [${finding?.id ?? '?'}] ${path}（样本 ${sha}，${status}）`,
          `   主张：${String(finding?.message ?? '').trim()}`,
          `   引文：${evidence === '' ? '(未给出引文 —— 没有引文即无法锚定)' : evidence}`,
        ].join('\n')
      }),
  ].join('\n')

  return {
    system,
    instructions: '逐条给出 keep / drop / undecided 与最强反驳；不得新增发现，不得改写措辞，不得声称分析完整，涉及授权的问题一律 undecided。',
  }
}

export default defineReviewPrompts({ review, verify })
