// Generator for domains/user-feedback/rules/*.md.
//
// Kept as a script rather than 25 hand-written files so the front-matter shape is
// identical across the library: `validateRule` requires `name` (lowercase kebab),
// a non-empty `match` glob array and `needs-expert-review: true`, and one typo in
// one file would fail the whole domain. The generated `.md` files are the deliverable.
//
// ── WHY THE EXTENSION SET IS DERIVED FROM index.js (t42) ──────────────────────
// This file used to carry its own `LEDGER_DOCS` — four globs, no `.md` — while
// `index.js` declared `GATE_EXTENSIONS` with five extensions, `.md` among them. Two
// independent constants with nothing keeping them equal, so the rule library could be
// corrected by hand and silently reverted the next time this module was imported. It
// was: 25 committed rule files went back to the generator's four-glob answer and the
// declared `.md` ledger was reviewed with an empty checklist again.
//
// That is a drift defect by CONSTRUCTION, not an editing accident — with two sources
// of truth the only open question is when they diverge. So the extension set now has
// exactly one source: the pack's own `GATE_EXTENSIONS`, which is the declaration a
// consumer of this domain reads. A rule that genuinely wants a NARROWER set can still
// say so (`JSON_ONLY` below), but no rule can name an extension the pack does not
// admit, and widening the pack widens the library on the next run instead of never.
//
// ── WHY IMPORTING THIS FILE IS SAFE (t42) ────────────────────────────────────
// Writing used to happen at module top level, so merely `import()`-ing this file —
// which a probe that "imports every module under domains/ to check they all parse"
// does naturally — rewrote 25 committed files as a side effect. A module's top level
// now only builds an in-memory map. The filesystem is touched only when this file is
// the process entry point AND is asked explicitly:
//
//   node domains/user-feedback/rules/_generate.mjs            # --check (default): no writes
//   node domains/user-feedback/rules/_generate.mjs --write    # regenerate
//
// The `_` prefix would keep `lib/domain-loader.js` from treating this as a rule
// document, except that the loader reads `rules/*.md` and not `rules/*.mjs`, so it is
// invisible to it regardless.

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runEntry } from '../_generate-util.mjs'
import { GATE_EXTENSIONS } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The two rules that deliberately apply to JSON ledgers only.
 *
 * An explicit constant rather than something folded into `LEDGER_DOCS`, because the
 * narrowing IS a decision: for a `.yaml`/`.yml`/`.md`/`.csv` ledger these two rules are
 * not injected, and the reviewer is not told. Narrowing is allowed — what is not allowed
 * is narrowing that nobody can see — so `test.mjs` enumerates the complete set of rules
 * narrower than the declared extension set and fails when that set changes. A new entry
 * there is not automatically wrong; it is a decision someone has to make on purpose.
 */
const JSON_ONLY = ['**/*.json']

/**
 * The default match list, DERIVED from the pack's own declaration rather than restated.
 * Order follows `GATE_EXTENSIONS` so the intersection is readable at a glance.
 */
const LEDGER_DOCS = GATE_EXTENSIONS.map((extension) => `**/*${extension}`)

const rules = [
  ['one-sided-closure', LEDGER_DOCS, 'critical',
    '单边闭环：决策的 `addresses` 里写了这条反馈，但反馈自己的 `closedBy` 不是它（或根本没写）。闭环被宣布了，但没有被对方确认。取证义务：给出反馈 ID、决策 ID，以及两侧声明各自的实际取值（`addresses` 有/无、`closedBy` 指向谁）。不算：两侧都写了但指向不同的决策 —— 那是「指向冲突」，比单边更严重，单独成条。'],
  ['dangling-closure', LEDGER_DOCS, 'critical',
    '悬空闭环：反馈的 `closedBy` 指向一个在 `decisions` 里根本不存在的 ID。这条反馈看起来已经关闭，实际关闭它的东西不存在。取证义务：给出反馈 ID、它声明的 `closedBy` 值，以及台账里 `decisions` 的全部 ID。不算：`closedBy` 指向的决策存在、只是没在 `addresses` 里提起这条反馈 —— 那是单边闭环，不是悬空。'],
  ['unclosed-feedback', LEDGER_DOCS, 'high',
    '无闭环反馈：既没有 `closedBy`，也没有任何决策在 `addresses` 里提到它。用户报了，台账上没有任何东西接过它。取证义务：给出反馈 ID、它的严重度与影响面、以及被报次数 —— 这三项决定了它有多不该被漏掉。不算：反馈状态是 `duplicate` 且指向了被合并到的那条 —— 那是已知的合并，不是漏掉。'],
  ['orphan-decision', LEDGER_DOCS, 'medium',
    '孤儿决策：这个决策没有 `addresses` 任何反馈，也没有任何反馈的 `closedBy` 指向它。它也许做了别的事，但它与反馈台账无关。取证义务：给出决策 ID、它的标题与状态，并说明它是否出现在任何 `addresses`/`closedBy` 里。不算：决策刚创建、状态是 `planned` —— 那还没有产生闭环是正常的；只有当它声称是 `shipped`/`done` 时才成问题。'],
  ['unregistered-reference', LEDGER_DOCS, 'high',
    '失效链接：台账的某条链接引用了一个 ID，而这个 ID 在 `feedback`、`decisions`、`themes` 里都没有登记。链接指向空气。取证义务：给出被引用的 ID、引用它的 ID、以及链接的方向（`addresses` 还是 `closedBy`）。不算：被引用的 ID 是外部系统的工单号且台账里有 `externalIds` 映射 —— 那是有意的外部引用。'],
  ['duplicate-id-across-populations', JSON_ONLY, 'critical',
    '跨population重名：同一个字符串既是某条反馈的 ID，又是某个决策（或主题）的 ID。此后任何只写这个 ID 的声明都无法判断指的是哪一个。取证义务：给出这个 ID，并列出它在每个 population 里的位置。不算：反馈 ID 与决策 ID 前缀不同（`fb-` / `dec-`）但尾部数字相同 —— 那是两个不同的 ID。'],
  ['duplicate-id-across-documents', JSON_ONLY, 'high',
    '跨文档重复 ID：同一个反馈 ID 出现在两份台账文档里。两份记录可能不一致，而按 ID 查询会静默取到其中一份。取证义务：给出该 ID 与两份文档的路径，并指出两份记录在哪些字段上不同。不算：同一份文档里 ID 出现两次且内容完全相同 —— 那是导出工具的重复行，标为数据质量问题而非本规则。'],
  ['paraphrased-quote', LEDGER_DOCS, 'critical',
    '转述引文：提交的引文不是用户原话的逐字片段，而是被改写得更通顺的版本。引文一旦被改写就不再是证据，它变成了评审者的说法。取证义务：给出你声称的原话片段与记录里实际的原文，并指出第一处差异的位置。不算：原文有换行或缩进差异（空白被折叠后一致）—— 那仍是逐字。'],
  ['quote-without-record', LEDGER_DOCS, 'high',
    '引文不唯一：这段文字在台账的多条反馈原话里都逐字出现，而声明没有给出 `feedbackId`。引文本身不能确定说的是哪一条。取证义务：列出所有逐字包含该片段的反馈 ID。不算：其中一条是另一条的完全重复粘贴且台账已标 `duplicate` —— 那是同一件事的两条记录，按合并后的那条报。'],
  ['severity-without-reach', LEDGER_DOCS, 'medium',
    '只有严重度没有影响面：记录了 `severity` 却没有 `reach`，于是「多严重」有了、「多少人受影响」没有，损失无法估量。取证义务：给出反馈 ID 与它缺失的字段。不算：这是内部工具反馈、影响面可确定为「仅内部」—— 那应当显式写成 `reach: one`，而不是留空。'],
  ['frequency-without-severity', LEDGER_DOCS, 'medium',
    '只有频次没有严重度：条目只有 `frequency`，于是排序只能按次数，而这正是把低频高损项淹没的机制。取证义务：给出反馈 ID 与被报次数。不算：`frequency` 为 1 且台账标注为一次性事件 —— 那仍然需要严重度，一次数据丢失也不该因为没有复现次数而失分。'],
  ['drown-risk', LEDGER_DOCS, 'high',
    '高损低频被淹没：某条反馈的「严重度 × 影响面」排在前四分之一，而被报次数排在倒数一半 —— 按次数排序时它会被挤到看不见的地方。取证义务：给出反馈 ID、它在两个排序里的位置、以及它的严重度与影响面取值。不算：这条已经在报告的单独清单里被点名 —— 那是本条规则的期望结果，不是违规。'],
  ['theme-tag-vs-membership', LEDGER_DOCS, 'medium',
    '主题两写不一致：反馈记录上的 `theme` 与主题目录里 `members` 列表对不上，一侧有另一侧没有。按主题分捆时会漏掉或多余。取证义务：给出主题 ID、反馈 ID，以及两侧各自的内容。不算：主题目录里根本没有这个主题（`themes` 未收录）—— 那是主题目录缺失，单独成条。'],
  ['theme-without-members', LEDGER_DOCS, 'low',
    '空主题：主题被声明了，但既没有 `members`，也没有任何反馈把自己的 `theme` 写成它。这个主题名存实亡。取证义务：给出主题 ID 与它的 `name`。不算：主题是刚建的分类骨架、台账里确实还没有属于它的反馈 —— 那标注为「待归入」而不是问题。'],
  ['closure-reason-missing', LEDGER_DOCS, 'medium',
    '闭环无理由：`closedBy` 有了，但 `closeReason` 缺失。闭环成立了，可为什么关掉这件事没有留下。取证义务：给出反馈 ID 与关联的决策 ID。不算：决策本身的 `rationale` 里明确写了为什么处理这条反馈 —— 那理由在决策侧，引用它即可，不必重复。'],
  ['closure-without-status', LEDGER_DOCS, 'medium',
    '闭环与状态矛盾：`closedBy` 已经指向某个决策，但反馈自己的 `status` 还是 `open`/`new`/`triage`。同一条记录里两个字段互相打脸。取证义务：给出反馈 ID、`status` 的实际取值、`closedBy` 的实际取值。不算：状态是 `in-progress` 且决策状态也是 `in-progress` —— 那两侧一致地表示未完成，`closedBy` 应改名为期待中的决策，单独成条。'],
  ['reopened-without-reason', LEDGER_DOCS, 'high',
    '重开无理由：反馈被重开（`status` 回到开启态，或 `reopened: true`），但没有任何字段说明为什么上一次关闭不成立。取证义务：给出反馈 ID、上一次的 `closedBy`、以及重开后的状态。不算：重开后立刻有了新的 `closedBy` 指向另一个决策并写了理由 —— 那是有记录的二次处理。'],
  ['feedback-without-source', LEDGER_DOCS, 'low',
    '来源缺失：反馈没有 `source`，无法判断它来自客户、内部还是自动探测 —— 也无法判断它该按什么口径定影响面。取证义务：给出反馈 ID 与它的原话片段。不算：原话里明确写了渠道（「在应用商店评论里说」）—— 那信息在，只是没进字段，标为「应结构化」而非缺失。'],
  ['duplicate-quote', LEDGER_DOCS, 'medium',
    '重复原话：两条不同的反馈 ID 记录了逐字相同的原话。要么是同一条被录了两次，要么是两条恰好措辞相同 —— 两种都需要判断，而按 ID 分开处理会重复计数影响面。取证义务：给出两个反馈 ID 与那段原话，并说明它们在其它字段（来源、日期、严重度）上是否也相同。不算：两条原话相同但来源渠道不同（一处应用商店、一处客服工单）—— 那是两个独立用户报了同一句话，是影响面的证据，不是重复。'],
  ['severity-inflation', LEDGER_DOCS, 'medium',
    '严重度与原文不符：`severity` 标为高危/阻断，但原话描述的只是一个观感或文案问题，没有任何功能失效或数据损失的描述。严重度是排序的输入，凭空拔高会让真正的高损项失去位置。取证义务：给出反馈 ID、它的 `severity`，以及原话中支持或不支持该定级的句子。不算：原话简短但描述的是「钱算错了」这类结果性损失 —— 简短不等于轻微。'],
  ['decision-addresses-everything', LEDGER_DOCS, 'medium',
    '决策包罗万象：一个决策的 `addresses` 覆盖了台账里过半的反馈。这类决策通常不是真的处理了每一条，而是被当成了兜底归集，使闭环数据失去分辨力。取证义务：给出决策 ID、它声明的条数、以及台账反馈总数。不算：系统迁移或统一修复确实一次解决了大量同源问题 —— 那要求这些反馈属于同一主题，给出主题证据即可。'],
  ['feedback-not-reproducible', LEDGER_DOCS, 'medium',
    '原话不可复现：原话只有情绪或评价（「太难用了」），没有任何可复现的现象、操作路径或结果。这样的反馈无法被验证，也无法在关闭时说明关掉了什么。取证义务：给出反馈 ID 与原话，并指出它缺少哪一个要素（现象 / 操作 / 结果）。不算：原话虽然简短但给出了具体现象（「导出少一行」）—— 那是可复现的，只是没有给出重现步骤。'],
  ['internal-source-as-customer', LEDGER_DOCS, 'low',
    '内部来源被当作客户反馈：原话的发出者是内部同事或测试同学，但台账把它按客户反馈的口径计入了影响面。影响面会被系统性高估。取证义务：给出反馈 ID、它的 `source`，以及原话里能看出身份的依据。不算：内部同事实习用户身份报的问题（他们也是用户）—— 那需要在 `source` 里同时记录身份与用户身份，而不是排除。'],
  ['resolution-mismatch', LEDGER_DOCS, 'high',
    '闭环理由与决策不符：`closeReason` 描述的处理方式与所指向决策的标题/状态对不上（例如理由是「已加提示文案」而决策是「重构结算页」且状态 `planned`）。闭环被挂在了一个没有做这件事的决策上。取证义务：给出反馈 ID、`closeReason` 原文、决策 ID 与它的标题和状态。不算：决策是父任务、子任务里做了这件事 —— 那要求指出子任务 ID，否则视为不符。'],
  ['single-report-critical-loss', LEDGER_DOCS, 'high',
    '单报高损：被报次数只有 1，但原话描述的是数据丢失、资金错误或权限越权这类不可逆损失。按次数排序时它排在最后，而它本该排在最前。取证义务：给出反馈 ID、被报次数、以及原话中描述不可逆损失的那句话。不算：原话描述的是可撤销的展示错误（一次刷新即恢复）—— 那不属于本规则的不可逆类别。'],
]

/**
 * Every rule document this generator would produce, as `name -> text`. Pure: no
 * filesystem access at all, so the check path and the write path render identically and
 * a caller — `test.mjs` included — can compare what WOULD be written against what IS
 * committed without writing anything.
 */
export function renderRules() {
  const rendered = new Map()
  for (const [name, match, severity, text] of rules) {
    const front = [
      '---',
      `name: ${name}`,
      'match:',
      ...match.map((glob) => `  - "${glob}"`),
      'needs-expert-review: true',
      `severity: ${severity}`,
      'source: agent-drafted',
      '---',
      '',
      text,
      '',
    ].join('\n')
    rendered.set(`${name}.md`, front)
  }
  return rendered
}

runEntry({ moduleUrl: import.meta.url, label: 'rules/_generate', here, render: renderRules })
