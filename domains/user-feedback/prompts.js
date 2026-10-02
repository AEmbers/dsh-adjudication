/**
 * user-feedback — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT enforce
 * that — `validateReviewPrompts` and `validateDomainPackV2` both return `[]` for
 * identical prompts — so an identical pair would sail through the completion gate
 * while quietly deleting the P6 layer: a reviewer "independently re-checking" its own
 * reasoning is not an independent re-check. `test.mjs` asserts the difference, and
 * `verify()` is built so it CANNOT see the P4 reasoning: it receives findings, never
 * the review transcript and never the rules.
 *
 * WHAT AN ANCHOR IS IN THIS DOMAIN
 * --------------------------------
 * A pair of ids, or an id plus a verbatim quote. Two consequences the P4 prompt must
 * state plainly, because both are counter-intuitive to a model that has been asked to
 * "review the feedback":
 *
 *   1. **A closure needs both sides.** "The ticket is closed" is not an
 *      observation unless the decision record agrees. A reviewer that reads only
 *      the feedback table will report a clean ledger; a reviewer that reads only the
 *      decision log will report a well-run process. The defect is between them.
 *   2. **A quote is verbatim or it is nothing.** Summarising a user's complaint into
 *      a nicer sentence is exactly what makes it unanchorable. The engine compares
 *      the submitted quote against the recorded one, whitespace aside.
 *
 * WHY THIS DOMAIN ADDS A THIRD DUTY
 * ---------------------------------
 * Recall-first changes what "I found nothing" costs. In a precision-first domain a
 * missed item is invisible; here a silently dropped feedback item is a trust loss —
 * the user reported it, someone decided it did not matter, and nothing recorded that
 * decision. So the P4 prompt carries two extra obligations that have no counterpart in
 * the sibling precision-first domain:
 *
 *   • **List every gap, never a count.** "8 of 14 closed" hides which six are open,
 *     and the six are the entire deliverable.
 *   • **Keep the two rankings apart.** Severity x reach and report count are
 *     different questions with different answers, and merging them into one score is
 *     how a twice-reported data-loss bug loses to a forty-times-reported cosmetic
 *     one. The domain's `drownRisk` list exists for exactly those items.
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will assert
 * them as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'
import { globToRegExp } from '../../lib/engine.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为「待人工确认」；只有被证据正面否定时才删除。一条被静默丢掉的反馈就是一次信任损耗。',
})

/** The claim kinds, as one string each prompt role quotes verbatim. */
const CLAIM_KINDS = [
  '`closure-link`（`{feedbackId,decisionId}` —— 「这条反馈由这个决策闭环」，**两侧互证**才成立）',
  '`one-sided-closure`（`{feedbackId,decisionId}` —— 「这条闭环只有单边声明」，正是本域最常见的缺陷）',
  '`unclosed-feedback`（`{feedbackId}` —— 「这条反馈无人处理」，两侧都没有）',
  '`orphan-decision`（`{decisionId}` —— 「这个决策没有对应任何反馈」）',
  '`quote-anchor`（`{feedbackId,quote}` —— 「台账里就是这么写的」，引文必须逐字）',
  '`theme-membership`（`{themeId,feedbackId}` —— 「这条反馈属于这个主题」，记录上的 `theme` 与主题目录的 `members` 两侧一致）',
  '`one-sided-theme`（`{themeId,feedbackId}` —— 「主题归属只有单边」）',
  '`unregistered-reference`（`{referencedId,referrerId}` —— 「台账链向一个不存在的 ID」）',
    '`closure-edge`（`{feedbackId,decisionId}` —— 枚举器对同一条闭环边的叫法，与 `closure-link` 同义）',
    '`feedback-node`（`{feedbackId}` —— 「这条反馈在台账里存在」，逐字定位到它的那一行）',
    '`decision-node`（`{decisionId}` —— 「这条决策在台账里存在」，逐字定位到它的那一行）',
    '`theme-node`（`{themeId}` —— 「这个主题在台账里存在」，逐字定位到它的那一行）',
]

/**
 * The anchor law, in this domain's vocabulary.
 *
 * Explicit about all eight claim kinds: a model that does not know what a claimable
 * relationship is will invent one, and the engine answers `kind-mismatch` for every
 * finding in the run. The pair structure is deliberate — each relation has a MUTUAL
 * form and a PARTIAL form, because "this is closed" and "this is closed on one side
 * only" are different facts and the second one is the domain's signature defect.
 */
const ANCHOR_LAW = [
  '锚点铁律：**锚点是 ID 对或 ID＋逐字原话，不是描述**。你提交的是 `locator.kind` 加上具体的 ID（或逐字引文），引擎在台账上重算这条关系是否存在。',
  `可以声明的只有八种：${CLAIM_KINDS.join('；')}。`,
  '**闭环必须两侧一致**：决策的 `addresses` 与反馈的 `closedBy` 都要指向对方，`closure-link` 才成立。只在一侧出现时，用 `one-sided-closure` 声明它 —— 不要把单边声明写成 `closure-link`，那会被引擎拒绝；也不要把它写成「未处理」，那与台账不符。',
  '**引文必须逐字**。把用户原话改写得「更通顺」会使它无法锚定 —— 引擎逐个字符比对（只忽略空白）。转述不是原话。',
  'ID 必须**逐字抄写**，包括连字符与大小写：`fb-1001` 不是 `FB-1001`，也不是 `fb1001`。写错一个字符，引擎就判未锚定，而它不会替你猜。',
  '**不要写「闭环率偏低」这类结论**。「有几条没闭环」不是可锚定的发现 —— 必须逐条给出反馈 ID 与它缺的是哪一侧。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '用户反馈'}（${domain?.id ?? 'user-feedback'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

/**
 * F2 — the VISIBLE half of the extension/rule intersection defect, and here it
 * matters more than in project-management.
 *
 * `lib/engine.js:selectRules` returns `{ injected, unmapped }`; `index.js:997`
 * puts `unmappedPaths` on every bundle. So "these candidates matched NO rule" was
 * already known and reached nothing: the bundle rendered the quiet line
 * "(本轮没有匹配到规则)" and the reviewer judged with no checklist and no signal
 * that something was misconfigured. Before the fix this domain admitted a `.md`
 * ledger with **0 rules** — the pack declaring `.md` readable while every rule
 * globbed only `*.json`.
 *
 * That defect is worse here than anywhere else in the family, and the reason is
 * this domain's loss orientation: a review running with an empty rule set does not
 * raise FEWER findings, it stops NOTICING the ones the rules encode. In a
 * recall-first domain the loss lands precisely on the class of item the domain
 * exists to not drop — silently discarded feedback is trust erosion.
 *
 * So the prompt says it out loud, from the only route this domain's own files
 * have to a reader (`index.js` renders the plan summary and is out of scope, so
 * the domain carries its own warning rather than depending on a layer it does not
 * own). Two claims are kept apart: a candidate with no matching rule is NOT thereby
 * clean; and a candidate whose extension this pack never declared readable is a
 * CONFIGURATION defect to be named, not a file to skip.
 *
 * `unmappedPaths` is read from `context.bundle` (the reasoner spreads the bundle)
 * with a top-level fallback, so a caller reshaping the context does not silently
 * re-disable the warning.
 *
 * BUT IT IS NOT TRUSTED AS THE TRIGGER, and that is worth stating precisely.
 * `lib/engine.js:selectRules` computes `unmapped` as `paths` minus ONE
 * representative per injected rule (`unmapped.splice(unmapped.indexOf(hit), 1)` —
 * it removes the first matching path, not every matching path). With one glob
 * family, every rule picks the same `hit`, so exactly one path is ever removed and
 * `unmappedPaths` comes back non-empty for essentially any bundle with two or more
 * paths — even when every single path matched a rule. Warning on that field
 * directly would have produced a permanent false alarm and trained the reviewer to
 * ignore the one warning that matters.
 *
 * So the true set is RECOMPUTED here from `pack.ruleLibrary.rules` (the globs the
 * loader actually assembled) against `bundle.paths`, using the engine's own
 * `globToRegExp` so the two agree by construction. The kernel field is used only
 * as a last-resort fallback when the pack in hand carries no globs at all — and in
 * that case a bundle with zero rules warns about every path, because that is the
 * one starvation signal that needs no globs to be certain.
 *
 * Injected into P4 ONLY: P6's independence rests on it not receiving the rule set,
 * and "which documents had no rule" is a statement about the review's
 * configuration — showing it to the re-checker would invite it to reason about the
 * review instead of about the ledger.
 */

/** Does any glob on `rule` match `path`, with the engine's own glob semantics? */
function ruleMatches(rule, path) {
  const patterns = Array.isArray(rule?.match) ? rule.match : [rule?.match]
  const target = String(path).replace(/\\/gu, '/')
  return patterns.some((pattern) => typeof pattern === 'string' && globToRegExp(pattern).test(target))
}

/** The candidates in this bundle that no rule in the library covers. */
function unmappedPaths(context) {
  const paths = Array.isArray(context?.bundle?.paths) ? context.bundle.paths : []
  const library = context?.pack?.ruleLibrary?.rules
  if (Array.isArray(library) && library.length > 0 && paths.length > 0) {
    return paths.filter((path) => !library.some((rule) => ruleMatches(rule, path)))
  }
  const injected = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  const kernelList = context?.bundle?.unmappedPaths ?? context?.unmappedPaths
  if (injected.length === 0 && paths.length > 0) return paths
  return Array.isArray(kernelList) ? kernelList : []
}

function unmappedWarning(context) {
  const paths = unmappedPaths(context)
  if (paths.length === 0) return ''
  const listed = paths.map((path) => `- ${String(path)}`).join('\n')
  return [
    `## ⚠️ 有 ${paths.length} 个候选没有被任何规则覆盖`,
    '本轮 bundle 里下列候选，没有任何一条规则的 `match` 命中：',
    listed,
    '',
    '**这不等于「这些反馈没有问题」**，只等于「本轮没有规则告诉你要检查它们什么」。本领域的损失取向是 recall-first：规则覆盖不到的地方，损失不是多一条误报，而是**该暴露的反馈没有被注意到**。规则库是 agent 起草的清单（`needs-expert-review: true`），覆盖不到处是本领域的**已知盲区，不是清白证明**。因此：',
    '- 对这些候选，只按台账上的事实判断，并在发现里**明确写出「本轮无规则覆盖」**；',
    '- 不要因为无规则可用就把它们当作已闭环 —— 本领域里「看起来没问题」恰恰是最需要写清楚理由的结论；',
    '- 如果某个候选的后缀不在本领域声明的可读类型里，那是**配置缺陷**（gate 的 extensions 与规则的 match 没有交集），请直接把它作为一条发现指出，而不是跳过。',
  ].join('\n')
}

export default defineReviewPrompts({
  /**
   * P4 — the bounded review pass.
   * Receives rules, the bundle's paths and the run's budget; does the judging.
   */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)
    const unmapped = unmappedWarning(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界反馈台账评审（P4）**。台账有两半：用户报上来的反馈（含原话、严重度、影响面、被报次数），以及团队做过的决策（含它声明处理了哪些反馈）。你只对这两半之间的**一致性**负责 —— 不评价产品方向，不评价用户说得对不对，也不评价决策做得好不好。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      '',
      '## 本轮的锚点铁律',
      ...ANCHOR_LAW,
      '',
      '## 关系型的核心：单看一半都没有问题',
      '这个领域的缺陷**不在任何一条记录里**，而在两半之间。逐条读反馈，每一条都写得很清楚；逐条读决策，每一个都理由充分。问题出在它们对不上：',
      '- 一条反馈的 `closedBy` 指向某个决策，而那个决策的 `addresses` 里没有它 —— 「已关闭」是单边宣布的。',
      '- 一个决策声明处理了五条反馈，其中三条的 `closedBy` 还指着别的决策，另两条根本没有 `closedBy` —— 声明与事实不符。',
      '- 一个决策谁也不提、也没有任何反馈指向它 —— 它也许做了别的事，但它与反馈台账无关。',
      '- 台账里链向一个不存在的反馈 ID 或决策 ID —— 断链。',
      '所以你的发现应当是一条关系（两个 ID）或一条记录在图中的位置，而不是对某条反馈质量的评价。',
      '',
      '## 本领域特有的两条义务（recall-first 的直接后果）',
      '**义务一：清单，不是计数。** 报告「14 条里有 8 条闭环」等于把另外 6 条藏起来 —— 而那 6 条正是这份工作的产出。每一条缺口都必须单独成条，写明反馈 ID、缺的是哪一侧（`addresses` 还是 `closedBy`）、以及你要下什么结论。',
      '**义务二：两个排序必须分开。** 「严重度 × 影响面」与「被报次数」是两个不同的问题，答案常常相反。一次上报但导致数据丢失的缺陷，按次数排序会被四十次上报的界面瑕疵淹没。你必须分别给出两个排序；两个排序里位置差异大的条目要单独点名，说明它属于哪一类。把两者合成一个分数是本领域最典型的失败模式。',
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是评审的经验清单，不是不可质疑的权威。规则与眼前的台账冲突时，以台账为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按台账上的事实判断，不要凭常识补规则。)' : rules,
      '',
      ...(unmapped === '' ? [] : [unmapped, '']),
      '## 工作方式',
      `- 本轮负责的文档：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行、≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。台账查询同理有上限，触到上限时工具会明说 \`truncated\`。`,
      '- 需要更多台账结构时先取证再判断（`closure_status`、`decision_links`、`unclosed_feedback`、`ledger_ranks`）。取证不到就降级为「证据不足」，而不是提高语气。',
      '- **取证的 `truncated: true` 不是证据**：`unclosed_feedback` 触到上限时没有列出的缺口，不等于不存在。',
      '- 每条发现给出：claim kind、涉及的 ID、你判断它为什么是问题、以及反方可能怎么说（defended 的依据）。',
      '',
      '## 输出',
      '只输出发现，不输出自然语言位置。台账自洽时输出空列表 —— 空列表是合法结论：一处一致、闭环完整的台账不该被挑出问题。但**在 recall-first 下，不要把「没找到」当成「不存在」**：你确实看不到的，写成「未覆盖」，不要写成「没有问题」。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent re-check.
   *
   * Deliberately shaped so it cannot inherit the P4 reasoning: it is handed findings
   * (claim kinds + ids + the quoted evidence) and the ledger, and nothing else. It
   * may only ask whether the claimed relationship holds and whether it proves the
   * conclusion.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'recall-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮评审的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对台账上的事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问三个问题，按顺序：',
      '1. **这条关系在台账里成立吗？** 逐字核对两个 ID 是否都存在、闭环是否**两侧**都指向对方、引文是否逐字出现在记录的原话里。只在一侧出现就是单边声明，直接判不通过，不要替它补上另一侧。',
      '2. **这条关系证明了结论吗？** 即使关系成立，也要判断它是否真的支持「这是一个问题」。一个决策没有对应反馈，可能只是它的反馈在别处登记；一条反馈只有单边 closedBy，可能确实是漏记。分清楚「关系缺失」和「关系缺失说明的问题」。',
      '3. **它说的是台账上唯一的读法吗？** 如果同一个 ID 在两份台账里都出现，或者同一段引文出现在多条反馈里，这条发现就没有唯一指向 —— 判不通过。',
      '只做这三件事。不要补充新发现，不要重写这条发现的措辞，不要因为「整体台账看起来还行」而放行。',
      '',
      '## 你要核对的声明种类',
      '本域只有这八种可核验的关系，逐条按它自己声明的种类核对：',
      ...CLAIM_KINDS.map((line) => `- ${line}`),
      '**单边与互证是两件事**：`closure-link` 要求两侧都指向对方；只在一侧出现时，正确的声明是 `one-sided-closure`。一条把单边写成 `closure-link` 的发现，即使描述得再准确，也是未锚定的。',
      '声明的种类不在上表里 —— 判不通过，不要替它归类。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['recall-first'],
      `**特别注意**：recall-first 下你只能**正面否定**时才判 drop。「我没找到证据」不是否定 —— 那是存疑，结论写 \`undecided\`，让损失取向去裁决。把存疑当否定，等于用复核层把 P4 的漏报又掩一遍。`,
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算台账上的事实正面支持它。',
      '允许的结论只有三种：`keep`（台账事实正面支持）、`drop`（事实正面否定或与台账矛盾）、`undecided`（存疑，交由损失取向裁决）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为找到了这条发现、就顺手认可它的严重度或修复建议。',
      '- 不可以在 ID 对不上、闭环只有单边、引文是转述时「折中」：对不上就是未锚定。',
      '- 不可以把「这个台账整体上很规范」当成任何一条发现的证据 —— 那是印象，不是台账上的关系。',
      '- **不可以把「复核时没看到」写成 drop。** 看不到是 undecided；drop 需要正面否定。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。但若这一轮覆盖不完整，请在结论里说明覆盖缺口，而不是宣布台账没有问题。)'
        : findings.map((finding, index) => [
          `### 发现 ${index + 1}：${finding?.id ?? '(无 id)'}`,
          `- 声称位置：${finding?.path ?? '(未给出)'}`,
          `- 声称的关系：${finding?.claim ?? finding?.locator?.kind ?? '(未声明 claim kind —— 未声明即为未锚定)'}`,
          `- 涉及的 ID：${Array.isArray(finding?.nodes) && finding.nodes.length > 0 ? finding.nodes.join(', ') : '(未给出 ID —— 未给出 ID 即为未锚定)'}`,
          `- 抄写的原文（若给出）：${typeof finding?.evidence === 'string' && finding.evidence !== '' ? `\n\`\`\`\n${finding.evidence}\n\`\`\`` : '(未给出)'}`,
          `- 结论：${finding?.message ?? '(未给出)'}`,
          `- 作者的辩护：${finding?.defended === true ? '已声明有证据支持' : '**未声明辩护**'}`,
        ].join('\n')).join('\n\n'),
    ].join('\n')

    const instructions = [
      '逐条复核，输出 `{ id, verdict, counterArgument, reason }`。',
      '`counterArgument` 必须先写：即使你最终判 `keep`，也要给出你考虑过并驳回的最强反驳。',
      '判 `drop` 时必须引用具体依据（ID 不存在 / 只有单边声明 / 引文与原文不一致 / 该关系不证明此结论 / 读法不唯一）。',
      '判 `drop` 时若理由只是「没看到证据」，请改判 `undecided` —— 本领域漏报比误报更贵。',
    ].join('\n')

    return { system, instructions }
  },
})
