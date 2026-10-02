/**
 * project-management — P4/P6 review prompts (contract v2, extension point 4).
 *
 * THE ONE THING THAT MATTERS HERE
 * -------------------------------
 * `review()` and `verify()` must not be the same text. The validators do NOT
 * enforce that — `validateReviewPrompts` and `validateDomainPackV2` both return
 * `[]` for identical prompts — so an identical pair would sail through the
 * completion gate while quietly deleting the P6 layer: a reviewer "independently
 * re-checking" its own reasoning is not an independent re-check. This domain's
 * `test.mjs` asserts the difference, and `verify()` is built so it CANNOT see the
 * P4 reasoning: it receives findings, never the review transcript or the rules.
 *
 * WHAT IS DIFFERENT ABOUT A GRAPH DOMAIN'S ANCHOR LAW
 * --------------------------------------------------
 * In `code-review` the anchor law is "copy the line, never the line number". Here
 * it is the same law in the graph's vocabulary: the model submits IDS and the kind
 * of relationship it is claiming, and the engine recomputes whether that
 * relationship exists. There is no line number to copy and no verbatim text either
 * — the plan's `title` is prose, and quoting it proves nothing about the graph. So
 * the law is:
 *
 *   never paraphrase an id, never invent an edge, and always name the claim kind.
 *
 * The failure this guards against is specific and common: an LLM asked to review a
 * plan will write "T4 与 T2 之间存在阻塞关系" — a true-sounding sentence that the
 * engine cannot confirm or refute, because it names no claim kind and no direction.
 * Such a finding is unanchored by construction, and both prompts say so.
 *
 * P4 (`review`)  — bounded, rule-injected, allowed to reason about the plan.
 * P6 (`verify`)  — adversarial fact-check, forbidden to reason about intent,
 *                  allowed only to ask "does the graph prove this or not".
 *
 * HONESTY: the rule text these prompts inject is agent-drafted and flagged
 * `needs-expert-review: true` in `rules/*.md`. The prompt says so to the model,
 * because a reviewer that believes its unchecked rules are authoritative will
 * assert them as facts.
 */

import { defineReviewPrompts } from '../../lib/contracts.js'
import { globToRegExp } from '../../lib/engine.js'

const ORIENTATION_LINE = Object.freeze({
  'precision-first': '本领域的损失取向是 precision-first：误报比漏报更贵。证据不足以证明时，**不要提出**。',
  'recall-first': '本领域的损失取向是 recall-first：漏报比误报更贵。存疑即保留并标注为待人工确认；只有被证据正面否定时才删除。',
})

/**
 * The anchor law, in this domain's vocabulary.
 *
 * Deliberately explicit about the claim kinds: a model that does not know
 * what a claimable relationship is will invent one, and the engine will return
 * `kind-mismatch` for every finding in the run.
 */
const ANCHOR_LAW = [
  '锚点铁律：**锚点是 ID 对，不是描述**。你提交的是 `locator.kind` 加上具体的 ID，引擎在任务图上重算这条关系是否存在。',
  '可以声明的只有五种：`task-edge`（`{from,to}` —— 「T4 依赖 T2」）、`cycle-path`（`{cycle:[T1,T2,T3]}` —— 「这三个任务互相阻塞」）、`orphan-task`（`{taskId}` —— 「T9 在这个计划里没有上下游」）、`unregistered-target`（`{targetId,referrer}` —— 「T1 等的那个 ID 图上根本不存在」）、`hedged-target`（`{targetId,referrer}` —— 「那个 ID 只出现在依赖里，没有任何记录说它是什么」）。',
  '候选卡片自带的四种叫法是**同一批事实的另一种说法**，引擎同样认：`dependency-edge`（`{from,to,edgeKind}` —— 与 `task-edge` 同一条边，另外逐字核 `edgeKind`）、`task-node`（`{taskId}` —— 「这个任务在计划里有一条记录」）、`risk-entry`（`{riskId}` —— 「这条风险登记项存在」）、`milestone-entry`（`{milestoneId}` —— 「这个里程碑存在」）。',
  'ID 必须**逐字抄写**，包括连字符与大小写：`T-12` 不是 `T12`，`T12` 不是 `t12`。写错一个字符，引擎就会判定未锚定，而它不会替你猜你想写的是哪个。',
  '**方向是有意义的**：`T4 dependsOn T2` 与 `T2 dependsOn T4` 是两条不同的边，前者成立不代表后者成立。声明方向时以 `dependsOn` 的实际值为准，不要按「谁先做」的直觉推断。',
  '**不要写「存在依赖问题」这类结论**。「图上有个环」不是可锚定的发现 —— 环必须给出完整路径。「T9 有问题」不是可锚定的发现 —— 要么它是孤儿，要么它有一条具体的边。',
  '未锚定的发现会被排除在有效发现之外，不计入覆盖率 —— 它不会因为你确信而变成有效的。',
]

function domainHeading(domain) {
  return `# ${domain?.title ?? '项目管理'}（${domain?.id ?? 'project-management'}）`
}

function ruleBlock(context) {
  const ruleText = context?.ruleText
  if (typeof ruleText === 'string' && ruleText.trim() !== '') return ruleText
  const bundleRules = Array.isArray(context?.bundle?.rules) ? context.bundle.rules : []
  if (bundleRules.length === 0) return ''
  return bundleRules.map((rule) => `## ${rule.name}\n${rule.text ?? ''}`).join('\n\n')
}

/**
 * F1 — the VISIBLE half of the extension/rule intersection defect.
 *
 * `lib/engine.js:selectRules` returns `{ injected, unmapped }`, and `index.js:997`
 * puts `unmappedPaths` on every bundle — so the information that "these candidates
 * matched NO rule" already exists, in a machine-readable field, and used to reach
 * nothing. A bundle whose rules came back empty renders the quiet line
 * "(本轮没有匹配到规则)" and then the reviewer judges with no checklist at all,
 * with no signal that something upstream is misconfigured. Silence about an empty
 * rule set is indistinguishable from a domain that legitimately has no rules.
 *
 * So the prompt says it out loud, in the P4 system text — the only route from this
 * domain's own files to a reader. (`index.js` renders the plan summary and is the
 * other natural home; it is outside this domain's scope, so the domain carries its
 * own warning rather than depending on a layer it does not own.)
 *
 * The two claims are kept apart deliberately:
 *   - a candidate with no matching rule is NOT thereby clean, and the reviewer is
 *     told to say "本轮无规则覆盖" rather than to treat it as passed;
 *   - if the candidate's extension is not one this pack declares readable, that is
 *     a CONFIGURATION defect, and the reviewer is told to name it as one rather
 *     than to quietly skip the file.
 *
 * `unmappedPaths` is tolerated from either `context.bundle` (the reasoner spreads
 * the bundle) or the top level, so this keeps working if the caller changes shape.
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
 * `globToRegExp` so the two agree by construction. The kernel field is used only as
 * a last-resort fallback when the pack in hand carries no globs at all — and in
 * that case a bundle with zero rules warns about every path, because that is the
 * one starvation signal that needs no globs to be certain.
 *
 * It is deliberately injected into P4 ONLY. P6's independence rests on it not
 * receiving the rule set, and a list of "documents no rule covered" is a statement
 * about how the review was configured — showing it to the re-checker would invite
 * it to reason about the review instead of about the graph, which is exactly what
 * P6 exists to prevent.
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
    '**这不等于「这些候选没问题」**，只等于「本轮没有规则告诉你要检查它们什么」。规则库是 agent 起草的清单（`needs-expert-review: true`），它覆盖不到的地方是本领域的**已知盲区，不是清白证明**。因此：',
    '- 对这些候选，只按图上的事实判断，并在发现里**明确写出「本轮无规则覆盖」**；',
    '- 不要因为无规则可用就把它们当作已通过，也不要凭常识临时编一条规则出来；',
    '- 如果某个候选的后缀不在本领域声明的可读类型里，那是**配置缺陷**（gate 的 extensions 与规则的 match 没有交集），请直接把它作为一条发现指出，而不是跳过。',
  ].join('\n')
}

export default defineReviewPrompts({
  /**
   * P4 — the bounded review pass.
   * Receives rules, the bundle's paths and the run's budget; does the judging.
   */
  review(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const bundle = context.bundle ?? {}
    const paths = Array.isArray(bundle.paths) ? bundle.paths : []
    const budget = context.budget ?? {}
    const rules = ruleBlock(context)
    const unmapped = unmappedWarning(context)

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你正在执行**一轮有界计划评审（P4）**。被审对象是一张任务图：节点是任务，边是依赖。你只对这张图的**一致性与完整性**负责 —— 不评价业务方向，不评价排期是否激进，也不评价任务该不该做。',
      '',
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 本轮的锚点铁律',
      ...ANCHOR_LAW,
      '',
      '## 关系型的核心：单看一个任务都没问题',
      '这个领域的缺陷**不在任何单个节点里**，而在它们之间。一个有环的图，每个任务的登记内容都是好的；一个有孤儿的图，那个孤立任务的描述可能写得非常清楚。所以：',
      '- 先看节点之间的关系，再看节点本身。你的发现应当是一条边、一条环路径、或一个节点在图中的位置。',
      '- 「周密的计划」这个整体印象不是证据。图上必须能指出具体的那条边。',
      '- 允许的例外只有一类：节点自身的登记缺陷（无负责人、无估算、blocked 无因）—— 那类发现的锚点就是该节点本身。',
      '',
      '## 规则库（agent 起草，标注 needs-expert-review: true，**未经领域专家审定**）',
      '规则是评审的经验清单，不是不可质疑的权威。规则与眼前的图冲突时，以图为准并说明冲突。',
      rules === '' ? '(本轮没有匹配到规则：只按图上的事实判断，不要凭常识补规则。)' : rules,
      '',
      ...(unmapped === '' ? [] : [unmapped, '']),
      '## 工作方式',
      `- 本轮负责的文档：${paths.length === 0 ? '(未指明)' : paths.join(', ')}`,
      `- 取证工具是有界的：单次读取 ≤${budget.maxExcerptLines ?? 200} 行、≤${budget.maxSearchHits ?? 100} 条，总调用 ≤${budget.maxToolCalls ?? 100} 次。图查询同理有上限，触到上限时工具会明说 \`truncated\`。`,
      '- 需要更多图结构时先取证再判断；取证不到就降级为「证据不足」，而不是提高语气。',
      '- **取证的 \`truncated: true\` 不是证据**：搜索触到上限时没有找到环，不等于没有环。',
      '- 每条发现给出：claim kind、涉及的 ID、你判断它为什么是问题、以及反方可能怎么说（defended 的依据）。',
      '',
      '## 输出',
      '只输出发现，不输出自然语言位置。想不出有证据支持的发现时，输出空列表 —— 空列表是合法且常见的结论：一张自洽的图不应该被挑出问题。',
    ].join('\n')

    return { system, rules, budget: { ...budget } }
  },

  /**
   * P6 — the independent re-check.
   *
   * Deliberately shaped so it cannot inherit the P4 reasoning: it is handed
   * findings (claim kinds + ids + the quoted evidence) and the graph, and nothing
   * else. It may only ask whether the claimed relationship exists and whether it
   * proves the conclusion.
   */
  verify(context = {}) {
    const orientation = context.orientation ?? context.pack?.lossOrientation ?? 'precision-first'
    const findings = Array.isArray(context.findings) ? context.findings : []

    const system = [
      domainHeading(context.pack ?? context.domain),
      '',
      '你是**独立复核者（P6）**，不是这轮评审的作者。你**看不到**上一轮的推理过程、语气和自述，只看到它给出的发现本身。这是刻意的：看得到推理，你就会去评价推理；看不到，你才只能去核对图上的事实。',
      '',
      '## 你的唯一职责',
      '对每条发现只问三个问题，按顺序：',
      '1. **这条关系在图里存在吗？** 声明的 ID 对/环路径/节点位置，逐字核对图上是否真有这条边。ID 对不上、方向反了、环没闭合，直接判不通过，不要替它找一条「它大概想说的」边。',
      '2. **这条关系证明了结论吗？** 即使边存在，也要判断它是否真的支持「这是一个问题」。存在一条跨团队依赖不等于交接没确认；一个任务有前置不等于它被阻塞了。',
      '3. **它说的是图上唯一的读法吗？** 如果两个不同任务共享一个 ID、或者同一组节点之间存在多条回路，这条发现就没有唯一指向 —— 判不通过。',
      '只做这三件事。不要补充新发现，不要重写这条发现的措辞，不要因为「整体计划看起来还行」而放行。',
      '',
      `## 本领域的损失取向：${orientation}`,
      ORIENTATION_LINE[orientation] ?? ORIENTATION_LINE['precision-first'],
      '',
      '## 反方义务',
      '对每条发现，先写出**最强的一条反驳**（「这条为什么不成立」），再给出结论。写不出任何反驳，才算图上的事实正面支持它。',
      '允许的结论只有三种：`keep`（图上事实正面支持）、`drop`（事实不足或与图矛盾）、`undecided`（存疑，交由损失取向裁决）。',
      '',
      '## 你不可以做的事',
      '- 不可以因为发现描述得详细、语气笃定就放行 —— 详细程度不是证据。',
      '- 不可以因为找到了这条发现、就顺手认可它的严重度或修复建议。',
      '- 不可以在 ID 或方向对不上时「折中」：对不上就是未锚定。',
      '- 不可以把「这个计划整体上很合理」当成任何一条发现的证据 —— 那是印象，不是图上的边。',
      '',
      '## 待复核的发现',
      findings.length === 0
        ? '(空集：没有发现需要复核。空集不是失败，也不要为它编造一条发现。一张自洽的图本来就该输出空集。)'
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
      '判 `drop` 时必须引用具体依据（ID 不存在 / 方向相反 / 环未闭合 / 该边不证明此结论 / 读法不唯一）。',
    ].join('\n')

    return { system, instructions }
  },
})
