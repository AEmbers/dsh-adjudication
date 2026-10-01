# 领域契约 v2（Domain Contract v2）

> 目标：把 19 个领域包从「只有声明」推到「端到端可运行」。本文是**接口的单一事实来源**，
> 机器可读的常量与校验函数在 [`lib/contracts.js`](../lib/contracts.js)，
> 自检在 [`contract-test.mjs`](../contract-test.mjs)（`npm run test:contracts`，34 条断言）。
>
> 本文回答 5 个问题：① 五个扩展点的确切 JS 接口；② 三个只声明未实现的字段如何接入引擎；
> ③ P4 有界推理回路用哪个 DSH 服务；④ 领域包如何组织与自动发现；⑤ 19 个领域各自的
> 「文档化输入格式」与 fixture 清单。

---

## 0. 硬约束（本文不得违反，实现也不得违反）

| # | 约束 | 落地方式 |
|---|---|---|
| 1 | 不得破坏现有 43 条 smoke 断言 + 13 条真实 Cordis 挂载断言 | 所有改动**只增不改**：新字段、新函数、新导出；v1 的 `lib/domains.js` 冻结 |
| 2 | 不得改变 `ctx.set` 必须先 `ctx.provide` 的规避方式 | `publish()` 的三段式尝试保持原样；新增服务一律走 `ctx.inject`，绝不写进静态 `inject` |
| 3 | 保持零运行时 import（**准确含义：零第三方依赖**） | `lib/contracts.js` 不 import 任何东西；`lib/domain-loader.js` **只有一个静态 import** —— 相对同级的 `./contracts.js`，不 import 任何第三方包，也不静态 import `node:fs`；规则 front-matter 用**内置最小解析器**，不引入 YAML 库 |
| 4 | Apache-2.0 与 NOTICE 的移植标注随代码更新 | 本轮新增的 `lib/contracts.js`、`contract-test.mjs` 为**原创**，无需新增 NOTICE 条目；任何移植 OCR 代码的新文件必须同步补 NOTICE |
| 5 | 规则库诚实前提 | `RULE_PROVENANCE` 把「agent 起草、未过专家审定」写进代码；`needs-expert-review` 不是 `true` 即校验失败；**任何交付物不得声称规则库已通过专家验证** |

> **措辞更正（t16 / t3 R4）**：t2 的交付报告里写过「`lib/domain-loader.js` 零 import」，那句话不准确，
> 在此更正：该文件**有一个静态 import** —— 相对同级的 `./contracts.js`；它不 import 任何第三方包，
> 也不静态 import `node:fs`/`node:path`/`node:url`，真实文件系统访问只经 `createNodeIo()` 工厂内部的
> **动态** import，或由宿主注入 `io` 完全绕开。**硬约束本身没有被破坏**（约束是「零第三方运行时依赖」），
> 被破坏的只是那句话的措辞。`lib/reasoner.js` 才是真正零 import 的文件（服务都以普通对象注入）。

---

## 1. 五个扩展点

### 1.0 共同规则

```js
// domains/<id>/index.js
export const contractVersion = 2
export default defineDomainPackV2({
  contractVersion: 2,
  id: 'code-review',
  title: '代码评审',
  category: 'A',
  lossOrientation: 'precision-first',
  candidateSet:   { kind: 'diff-hunks', inputFormat: 'unified-diff', description: '…' },
  candidateSource: <见 1.1>,
  anchor:          { kind: 'diff-line', description: '…', verify: 'engine-recomputable' },
  anchorVerifier:  <见 1.2>,
  evidenceTools:   <见 1.3>,
  reviewPrompts:   <见 1.4>,
  ruleLibrary:     <见 1.5>,
  criticism:       { kind: 'fact-checker', description: '…' },
  bundleKey:       { strategy: 'directory', depth: 1 },
  fixtures: ['empty', 'all-gated-out', 'happy-path', 'renamed-file'],
})
```

五条对所有扩展点都成立的通则：

1. **纯函数**：无 I/O、无时钟、无随机、无全局状态（`evidenceTools.execute` 是唯一允许异步的，且只允许通过 `ctx` 拿资源）。
2. **确定性**：同一输入必须得到同一输出。`test.mjs` 必须**跑两遍并 deep-equal**（P0 尤其）。
3. **有界**：任何可能随输入增长的返回值都必须有上界，超界要 `truncated: true` + `notes`，绝不静默截断。
4. **失败要响**：形状不合契约 → 抛 `contractError(code, …)`；**不猜**、不返回半个结果、不 fallback 到「看起来差不多」的答案。
5. **kind 必须自洽**：`candidateSource.kind === candidateSet.kind`，`anchorVerifier.kind === anchor.kind`。漂移由 `validateDomainPackV2` 拒绝。

---

### 1.1 `candidateSource` — P0 候选集枚举（文件 `domains/<id>/source.js`）

**签名**

```js
/**
 * @param {object} input   文档化输入，形状由 DOMAIN_INPUT_FORMATS[<id>].shape 给定
 * @param {object} context
 * @param {number} context.maxCandidates   闸门准入前的硬上限（默认 400）
 * @param {number} context.maxExcerptLines 单个候选 text 的行数上限（默认 500）
 * @param {string[]} context.include       调用方 include glob（只读，不得当作白名单用）
 * @param {string[]} context.exclude
 * @param {string[]|null} context.extensions
 * @returns {{
 *   candidates: Array<{
 *     id: string,            // 稳定且本次运行内唯一；重复即契约违规
 *     path: string,          // 闸门 glob 匹配的对象；非文件领域用合成长 id，如 'surface/data-flow-3'
 *     locator: object,       // 领域私有指针，交给 anchorVerifier
 *     text: string,          // 交给模型的有界摘录
 *     key?: string,          // 显式 bundle key（可选；否则由 pack.bundleKey 推导）
 *     additions?: number, deletions?: number, bytes?: number,
 *     binary?: boolean, deleted?: boolean,
 *     title?: string, meta?: object,
 *   }>,
 *   excluded: Array<{ id: string, reason: string }>,   // 源头即排除（例如条款不适用于该面）
 *   notes: string[],                                    // 例如 'truncated at 400 candidates'
 *   bounded: boolean,                                   // true 当且仅当枚举是输入的纯函数
 *   truncated: boolean,
 * }}
 */
enumerate(input, context)
```

**工厂与常量的导出**

```js
export default defineCandidateSource({
  kind: 'diff-hunks',          // 必须等于 pack.candidateSet.kind
  inputFormat: 'unified-diff', // 必须等于 pack.candidateSet.inputFormat
  bounded: true,
  describe: '把 `git diff --unified=3` 切成 (文件, hunk)',
  enumerate(input, context) { /* … */ },
})
```

**失败语义**

| 情形 | 行为 |
|---|---|
| 输入不是文档化形状（缺字段、类型不对） | 抛 `E_INPUT_FORMAT`，`message` 指明**哪个字段**、期望什么 |
| 输入合法但为空（无 diff / 无条款） | **不是错误**：返回 `candidates: []`。空集是合法结论 |
| 超过 `maxCandidates` | 截断到上限，`truncated: true`，`notes` 写明丢掉多少 |
| 单个候选摘录超 `maxExcerptLines` | 截断该 `text` 并记 `notes`；**不得**因此丢掉整个候选 |
| 输入里的自然排除信号 | 按 `GATE_FIELD_MAPPING` 映射到 `binary`/`deleted`/`bytes`，**交给闸门**，不要在 source 里自己判死（否则「被谁排除」就查不出来了） |
| `secretMatch` | source **不得**设置；由引擎的 `markSecrets()` 负责 |

**最小测试断言**

```js
const out = source.enumerate(fixture.input.payload, { maxCandidates: 400 })
assert.deepEqual(out.candidates.map((c) => c.path), ['src/a.ts', 'src/b.ts'])
assert.deepEqual(source.enumerate(fixture.input.payload, ctx), source.enumerate(fixture.input.payload, ctx)) // 确定性
assert.deepEqual(validateCandidateSetResult(out, { maxCandidates: 400 }), [])
```

**每个领域必须有的两个边界 fixture**

- `fixtures/empty.json` —— 空输入（空 diff / 空条款表 / 空任务图）→ `candidates: 0`，**不抛异常**。
- `fixtures/all-gated-out.json` —— 候选全部被 P1 排除 → `expect.admitted: 0` 且 `expect.excludedByPredicate` 覆盖**每一条**触发的谓词（`binary`/`deleted`/`secret`/`default-path`/`extension`/`too-large` 中至少一条）。闸门后为空时，工作单必须输出「空：闸门后无候选。这本身就是结论——不要凭空审核」而不是让模型强行产出。

---

### 1.2 `anchorVerifier` — P5 锚点重算（文件 `domains/<id>/anchor.js`）

**签名**

```js
/**
 * @param {object} claim   模型侧的锚点主张
 * @param {string} claim.kind     必须等于 verifier.kind
 * @param {string} claim.path     模型声称所在的候选
/**
 * @param {object} claim.locator  模型侧指针（可为 {}，若领域允许仅凭引文定位）
 *   CHANGED (t17): the engine passes this through VERBATIM — it is never rebuilt
 *   and no engine-invented key is ever injected into it. 19 domain shapes are
 *   declared below and the engine knows none of them.
 * @param {string} [claim.excerpt] 逐字抄写的原文（可为 ''）
 *
 * @param {object} subject 引擎侧材料（**唯一可信来源**）
 * @param {string} subject.path
 * @param {string} subject.content                规范化后的正文（diff 文本 / 文档 / 序列化后的图）
 * @param {object} [subject.document]             **完整**文档对象：`documents` 里与 `subject.path`
 *   同名的那一个，**其余字段一律保留**（领域自定义载荷如图数据只能从这里读）
 * @param {Array<{path:string,content:string,...}>} [subject.documents]  跨文档重定位用；其余字段一律保留
 * @param {object[]} [subject.candidates]          P0 产出，locator 空间在这里。
 *   CHANGED (t21): 引擎兑现此字段。有该领域的 plan 时，这里是那次 plan **闸门准入后**的候选集
 *   （`adjudication_plan` 的 `input` 经本域 `source.js` 枚举、或被调用方逐字交来的那份），
 *   条目是**领域自己的对象**，引擎逐字透传、不做任何重建。
 *   **未知时整个键缺席**（而不是空数组）——「没有提供候选集」与「提供了一个空候选集」
 *   是两件事，验证器有权区分（`risk-compliance` 的 `toBindings` 正是这么做的）。
 * @param {object} [subject.index]                 领域自建的确定性索引（可选）。
 *   **引擎不提供此字段**：它是给库调用者（直接调 `verify`）的入口，19 个已交付领域没有一个读它。
 *   写在签名里只是说明「出现了也不必惊讶」，不是一条引擎承诺。
 *
 * **领域载荷只能从 `document` / `documents` / `candidates` 取**（CHANGED / t21）
 *
 * 引擎**不会**把 `subject.document` 的字段**展开**进 `subject`。这条不是遗漏，是决定：
 * 展开必须由引擎决定「展开哪些键」，而引擎不认识任何领域数据的形状（第 19 种 locator 形状
 * 它都当作不透明对象）。真要展开，就得为「哪一个文档」「哪些键」「与 `path`/`content`/
 * `documents` 撞名怎么办」定规则 —— 那是引擎替领域做形状决策，正是 F3、locator 透传、
 * `toCandidates` 丢字段这一族的成因。
 *
 * 实践上也不需要：`subject.document` 已经带着**全部**字段（`{...doc, path, content}`），
 * 所以读 `subject.document?.flow` 这条路本来就是通的；`domains/project-management/anchor.js`
 * 的 `payloadOf(entry)` 就是现成范例，它同时接受 `{payload}` / `{graph}` / `{content:'<json>'}`
 * 三种自折叠写法，因此一个域既可以从**文档对象**读，也可以从**文档正文里的 JSON** 读回来。
 * 详细诊断与逐域修法见 §9。
 *
 * @param {object} context  { maxExcerptLines, signal }
 * @returns {{
 *   status: 'anchored' | 'unanchored',
 *   tier: 'declared-locator'|'recomputed-unique'|'relocated-unique'
 *       |'locator-mismatch'|'relocation-ambiguous'|'no-match'|'empty-excerpt'|'kind-mismatch'|'no-documents',
 *   path: string|null,
 *   start: number|null,   // 1-based；ID/图家族可为 null
 *   end: number|null,
 *   locator?: object,     // anchored 且无行号时，用它说明「锚在哪里」
 *   ambiguousIn?: string[],
 *   detail?: string,
 * }}
 */
verify(claim, subject, context)
```

**工厂**

```js
export default defineAnchorVerifier({
  kind: 'diff-line',                 // 必须等于 pack.anchor.kind
  verifyLevel: 'engine-recomputable',
  verify(claim, subject, context) { /* … */ },
})
```

**失败语义**（这一节是整套机制的地基）

- **只信 `subject`，不信 `claim`**：`claim.locator` 是一个待验证的假设，不是事实。locator 与 `subject` 矛盾 → `unanchored` + `tier: 'locator-mismatch'`，**不是**「以模型为准」。
- **歧义必须拒绝**：≥2 个同样成立的位置 → `unanchored` + `tier: 'relocation-ambiguous'` + `ambiguousIn` 列出全部竞争位置。与 `lib/engine.js` 的 `resolveAnchor` 同一条规则。
- **转述不锚定**：引文必须逐字（允许忽略缩进与 diff 标记）。改写 → `no-match`，降级为未锚定，不得"尽力而为"。
- **kind 不符** → `unanchored` + `kind-mismatch`；**claim 形状不合法**（缺 `kind`/`path`，或 `locator` 非对象）→ 抛 `E_ANCHOR_CONTRACT`。
- **verifier 不得调用模型**。OCR 的第三级是 LLM 重定位，本项目**有意不实现**（理由见 README「已知限制」#2）：模型猜出来的锚点不是引擎能重算的锚点。
- `tier ∈ TRUSTED_ANCHOR_TIERS`（`declared-locator`/`recomputed-unique`/`relocated-unique`）才允许 `status: 'anchored'`，由 `validateAnchorVerdict` 强制。**受信档位必须真的有生产者**（CHANGED (t49)，见下条）。

**裁决形状：行号**或**领域 locator，二选一**（CHANGED / t17）

`anchored` 必须说清「锚在哪里」，但**「哪里」不一定是一个行号**。契约声明的 19 种 locator 里，只有 `code-review` / `backend-engineering` / `frontend-engineering` 三个是行号家族（`{hunkIndex,startLine,endLine}`）；`risk-compliance` 的 `{clauseId,surfaceId}`、`data-engineering` 的 `{nodeId,table,column}`、`project-management` 的 `{taskId,from,to}` 根本**没有行**。所以：

| `status: 'anchored'` 时 | 要求 |
|---|---|
| 行号家族 | `Number.isInteger(start) && start >= 1`，且 `Number.isInteger(end) && end >= start` |
| ID / 图 / 条款 / 流程… 家族 | `start`/`end` 可为 `null`，但必须给出**非空的对象** `locator`（领域自己的定位器） |
| 两者都没有 | **非法** —— `validateAnchorVerdict` 拒绝 |

对应的受信档位是 `declared-locator`：语义是「claim 声明的定位被独立确认」，**确认的是行号还是 ID/图/条款节点，契约不区分**——形状由上面的表决定，名字只有一个。

> **`domain-locator` 已被移除（CHANGED (t49)）**。它由 t17 第二遍加入，当时的理由是「ID/图家族没有行号，需要一个受信档位才能合法地报 anchored」。实测结果是它**没有任何生产者**：19 份 `domains/<id>/anchor.js` 全量扫查，**包括它当初想服务的每一个 ID/图家族**，报的都是 `declared-locator`；`lib/engine.js` 的通用阶梯也不可能返回它。它唯一的生产者是 kernel 测试夹具——也就是说，这个档位**只被测试用过，用户跑的任何路径都用不到**。
>
> 为什么删而不是补一个生产者：那样等于**先造一个消费者来给一条死声明背书**，正是本队反复撞到的「声明先行、之后再说」；而它带来的能力是零——`validateAnchorVerdict` 一直允许「整数 range **或** 非空 locator 对象」，非行家族用 `declared-locator` 本来就能合法锚定。
>
> 它的守卫是**运行期断言**：`lib/kernel-test.mjs` §16「`TRUSTED_ANCHOR_TIERS` 里每个档位都必须有真实生产者」——生产者一侧是**执行**通用阶梯（`lib/engine.js`），另一侧是**扫查**已发运的 `domains/<id>/anchor.js`。这条断言在移除前是**红的**（唯一失败项就是 `domain-locator`），移除后转绿。
>
> 已知的同类缺口（**本次未修，如实记录**）：反方向也不成立——`lib/engine.js:168` 的阶梯会返回 `declared-document`，`anchorInDocument` 会返回 `sliding-window`，而这两个档位**不在 `ANCHOR_TIERS` 里**（通用阶梯路径不经过 `validateAnchorVerdict`，所以不会当场报错）。它们是有真实生产者的**未声明**档位，与 `domain-locator` 是同一族问题的镜像；修它意味着改动引擎的档位词汇表（影响 19 个域的回退路径语义），因此留给单独一次改动，而不是塞进这次移除里。

> **为什么改**：原先的校验要求 anchored 必须带整数 range 且 tier 在三个行号 tier 里。那是把 `code-review` 的形状当成了**唯一**形状 —— 换成规则层同样成立：**连契约本身都是行号家族假设**。后果是 ID/图家族的**诚实**裁决在契约上非法，会被调用方降级成 `invalid-verdict`，等于那些域永远出不了锚点。修正后行号家族的每一条要求原样保留（`contract-test.mjs` 的 34 条断言一字未动）。

**引擎对领域形状数据的义务**（CHANGED / t17 —— 一次穷尽扫查的结论）

同一类缺陷在本项目里出现过**四次**，每次都表现为「某一层自认为知道领域数据的形状，然后用一个固定键集把它重建出来」。因此把它写成规则，适用 `index.js` 与 `lib/` 的每一处：

1. **扩展，然后补默认值**（spread, then default）。永远不要重建。例：`toDocuments` 现在返回 `{...doc, path, content}`，`toCandidates` 返回 `{...item, additions, …}`，P4 的 `bundle` 上下文是 `{...bundle, key, paths, rules}`。
2. **`claim.locator` 原样透传给验证器**。引擎不重建它、也不向它注入自造键。只有当调用方**完全没给 locator** 时，引擎才把顶层的 `start`/`end` 折成 `{start, startLine, end, endLine}`（这样行号家族的既有行为字节不变；而给 ID 家族注入 `start` 会破坏验证器自己的「空 claim」检测）。
3. **不锤定的自报值不采信**。锚点一律重算；`coverage.total` 取 `max(调用方声明, plan 准入, 引擎实际锚定数)`。安全来自「验证器必须跑、抛出不得被吞」，**不是**来自「引擎重建数据」。
4. **有意投影要写明**。`plan.bundles[]` 给模型的是有界摘要 `{key, paths, rules, ruleText, unmappedPaths}`；`critiqueResult.dropped[]` 是 `{id, reason}`。这两个是**设计上的**裁剪（下游只需要这些），不是丢失，但凡是投影必须在代码里写明。

**已知边界：`normalizeLine` 剥离 diff 标记 ⇒ 以 `-`/`+` 开头的原文会被判 no-match**（KNOWN BOUNDARY / t17，**本轮有意不修**）

这条限制在实现里**存在且被断言**，不是待发现的坑。写在这里，是为了让下一个读到它的人知道它是**决定**，不是疏忽。

- **什么输入会失败**：`normalizeLine` 用 `/^[+-]/` 剥掉**第 0 列**的 diff 标记，再压掉全部空白。关键在于 **`^` 只匹配整行的第一个字符** —— 于是"这一行该不该被剥"取决于它**是否恰好以 `+`/`-` 开头**，而抄写原文与文档正文**未必在同一个位置上**：

  | 文档正文（post-image） | 抄写原文 | 规范化后 | 结果 |
  |---|---|---|---|
  | `  --focus-ring: x;`（缩进） | `--focus-ring: x;`（逐字，无标记） | `--focus-ring:x;` vs `-focus-ring:x;` | **`unanchored` / `no-match`** |
  | `  --focus-ring: x;` | `+--focus-ring: x;`（带 diff 标记） | `--focus-ring:x;` vs `--focus-ring:x;` | `anchored` |
  | `--focus-ring: x;`（第 0 列） | `--focus-ring: x;` | `-focus-ring:x;` vs `-focus-ring:x;` | `anchored` |
  | `--focus-ring: x;` | `+--focus-ring: x;` | `-focus-ring:x;` vs `--focus-ring:x;` | **`unanchored` / `no-match`** |
  | `  color: red;`（普通行） | 三种写法（`color: red;` / `+  color: red;` / `  color: red;`） | 均 `color:red;` | 全部 `anchored` |

  以上五行是**本机实测**的（`domains/code-review/anchor.js` 的 `verify`），不是推演。结论：**只有"自身以 `+`/`-` 开头"的原文受影响**（CSS 自定义属性 `--x`、YAML 序列项 `- x`、Markdown 列表项 `- x`、行首算术 `- 1` 等）；普通行三种写法都能锚定。受影响时，**抄写原文必须与文档正文在第 0 列带着同样个数的 `+`/`-`** 才匹配 —— 也就是说契约里"**允许忽略 diff 标记**"这句宽容，对这类行**只在一个方向上成立**（多带一个标记可能匹配，少带/不带则判 no-match）。

  这是**召回**损失，不是**精度**损失：它只会把本可锚定的引文判成未锚定，不会把假引文判成锚定（改写、改名、改标点仍然是 `no-match`）。另附一条同源实测观察：`locator.side` 目前**只做取值校验，不参与比对**，因此一条带着 `-` 标记（删除侧）的引文，若其正文与 post-image 某行同形，同样可以命中 —— 影响面与上表相同，限于自身以 `-` 开头的行。

- **为什么保留（三条，按权重）**：
  1. **与上游一致**。`domains/code-review/anchor.js:42-53` 的注释把 `normalizeLine` 标注为 `open-code-review` `internal/diff/resolver.go:301` 的复刻 —— 即"先剥一个标记、再压空白"是**上游的规则**。本项目把 `code-review` 当作**参照域**，其与上游的 parity 是交付目标之一（见 `COMPARISON.md`）；在这里单方面"修好"宽容度，会让参照域与上游不再可比。（**诚实标注**：`resolver.go:301` 的原文本机未独立核对 —— 本仓无 Go 工具链、无上游检出，此处采信 captain 的 grep 与既有移植标注。若将来有人拿到上游，请顺带核这一行。）
  2. **改动的爆炸半径大于收益**。`normalizeLine` 在本仓有 **13 份独立定义**（12 个领域各一份 + `lib/engine.js`），且**没有任何一个领域从 `lib/engine.js` 导入**它（详见下面「结构债」）。要修就得同时改 13 个文件、跨 5 个领域所有者的 inScope；两三个 agent 并行改同一批文件的风险远高于这条假阴性的实际损失。
  3. **设计本身接受这个取舍**。整套锚点机制的取向是**用召回换精度**（见上文「转述不锚定」）：宁可漏掉一条真锚点，不可采信一条假锚点。标记剥离正是这个取向在 diff 家族上的具体体现。

- **与上游的关系**：这是**继承来的**边界，不是本项目新引入的（据既有移植标注：`normalizeLine` 本就是上游规则的复刻）。本项目只是**不再掩盖**它 —— 把它写明，并锁进断言。**诚实标注**：上游源码本机未独立核对（无 Go 工具链、无上游检出），此处采信移植标注与 captain 的核对。

- **已被断言（改动它必须是有意的）**：
  - `domains/code-review/test.mjs` 的 `KNOWN BOUNDARY: a line whose own text starts with a diff marker is matched only when the marker counts agree`：上表**每一行**都有一条断言（无标记 → `unanchored`+`no-match`；带标记 → `anchored`；普通行三种写法 → 全部 `anchored`；同一行的改写 → 仍 `unanchored`），注释指向本节。
  - `lib/kernel-test.mjs` 第 **10** 节 `KNOWN BOUNDARY: the marker strip is position-0 only…`：同一个边界在**引擎原语层级**（`normalizeLine` / `anchorInDocument` / `resolveAnchor`）再断言一次，覆盖 12 份领域拷贝所复刻的那条规则。

  > 因此：将来若有人决定修它（例如改成"标记在任意缩进后也剥"，或"只有当标记后面还有内容、且该候选确实来自 diff 文本时才剥"），这两处断言会**失败**——这正是它们存在的意义：逼这次修改成为一次**有意的**决定，而不是一次静默的行为漂移。**本喵已实测这条保障有效**：把 `lib/engine.js` 与 `domains/code-review/anchor.js` 的标记剥离临时改成 `/^(\s*)[+-]/`（即"缩进后也剥"），两处新断言**各自失败**，其余断言不受影响；随后原样还原，五套门禁复绿。

**结构债：`normalizeLine` 应收敛为单一共享实现**（RECORDED DEBT / t17，**本轮不要求修**）

`lib/engine.js` 已经导出了 `normalizeLine`，但**没有一个领域使用它**；每个领域在自己的 `anchor.js` 里各抄了一份。当前实测的写法差异（三族）：

| 写法 | 文件 | 差异 |
|---|---|---|
| `String(line).replace(/^[+-]/, '').replace(/\s+/gu, '')` | `lib/engine.js:72`、`domains/code-review/anchor.js:51`、`domains/operator-design/anchor.js:42`、`domains/tech-doc/anchor.js:43`、`domains/tech-test/anchor.js:39` | 基准（含 `/u` 与 `/gu` 的细微差别） |
| `String(line).replace(/\s+/gu, '')`（**不剥标记**） | `domains/requirement-research/anchor.js:42`、`domains/risk-compliance/anchor.js:54`、`domains/ui-visual/anchor.js:53`、`domains/ux-review/anchor.js:43`、`domains/product-planning/anchor.js:34` | 同为"只压空白"，宽容度**高于**基准 |
| 领域自定义 | `domains/market-research/anchor.js:72`（额外剥 `[-+*>]` 与 `\d+[.)]` 列表标记、把空白压成单空格且 `trim()`）、`domains/algo-model/anchor.js:42` 与 `domains/data-engineering/anchor.js:73`（箭头函数版基准） | 语义已经**不同**（列表标记 + 空格保留） |

**为什么这算债**：三族写法对同一份输入会给出**不同裁决**。下面是三族在四个样本上的**实测**规范化结果（把三个 `normalizeLine` 的表达式原文取出、逐一求值）：

| 输入 | `base`（含 `/u`） | `whitespace-only` | `markdown-list-aware` |
|---|---|---|---|
| `- item` | `item` | `-item` | `item` |
| `  - item` | `-item` | `-item` | `item` |
| `--focus-ring: x;` | `-focus-ring:x;` | `--focus-ring:x;` | `focus-ring: x;` |
| `  --focus-ring: x;` | `--focus-ring:x;` | `--focus-ring:x;` | `focus-ring: x;` |

读法：**同一族内部就已经不一致**——`base` 下 `- item` 与 `  - item` 是**两个不同的串**（这正是上面那条已知边界），而 `whitespace-only` 与 `markdown-list-aware` 把它们归一。于是同一对（正文, 引文）在三个域里会得到三种结论：`base` 判 no-match、另两族判 match；而在 `--` 开头的行上 `markdown-list-aware` 又与另两族完全不同（它把 `[-+*>]+` 整段吃掉）。

今天没人受影响，是因为每个领域的验证器只在自己领域的正文上跑；但只要有人修了其中一份，或把两个领域的逻辑合并，**漂移就会立刻变成不一致的行为**。

**方向**：应收敛为 `lib/engine.js` 的**单一**共享实现（或一份显式的、按领域可选的策略表，例如 `strict-diff-marks` / `whitespace-only` / `markdown-list-aware` 三个具名策略），由 `defineAnchorVerifier` 显式声明选哪个。**未做**的原因与上面第 2 条相同（13 个文件、5 个 owner 的 inScope）。本项**不需要现在修**，但需要**被记录**——这样它是一个已知的债，而不是一个未来的意外。

**最小测试断言**

```js
// 正例
assert.equal(pack.anchorVerifier.verify(
  { kind: 'diff-line', path: 'a.ts', locator: { start: 2 }, excerpt: 'const x = 1;' },
  { path: 'a.ts', content: 'let y\nconst x = 1;\n', candidates: [] },
).status, 'anchored')

// 负例（每个领域强制至少一条）
assert.equal(pack.anchorVerifier.verify(
  { kind: 'diff-line', path: 'a.ts', locator: { start: 2 }, excerpt: 'const x = 2;' },
  { path: 'a.ts', content: 'let y\nconst x = 1;\n', candidates: [] },
).status, 'unanchored')
```

`validateFixture` 强制 `fixture.anchors.positive` 与 `fixture.anchors.negative` **都非空**；`anchors.ambiguous` 可选，但声明了就必须断言 `tier: 'relocation-ambiguous'`。

---

### 1.3 `evidenceTools` — P7 有界领域取证（文件 `domains/<id>/evidence.js`）

**签名**

```js
export default defineEvidenceToolkit({
  tools: [
    {
      name: 'read_slice',                     // 小写 snake_case；注册名 = adjudicate_<领域>_evidence_read_slice
      description: '读取某个血缘节点在指定行范围内的正文',
      parameters: { type: 'object', properties: { nodeId: { type: 'string' } }, required: ['nodeId'] },
      output: { schema: { type: 'object' } },
      limits: { maxLines: 200, maxItems: 50, maxBytes: 65536, maxCalls: 8 },  // 必填
      /** @param {object} args  @param {object} ctx { budget, signal, domain, pack } */
      async execute(args, ctx) {
        // 必须：ctx.signal.throwIfAborted()；必须：结果带 { items, truncated, provenance }
        return { items: [], truncated: false, provenance: 'node:n1' }
      },
    },
  ],
})
```

**有界性是硬性的**

```js
EVIDENCE_LIMITS = { maxToolsPerDomain: 8, maxCallsPerRun: 20, defaultMaxLines: 200,
                    hardMaxLines: 2000, defaultMaxItems: 100, hardMaxItems: 1000, hardMaxBytes: 262144 }
```

- `limits` 必填；`normaliseEvidenceLimits` **向下夹紧**到硬上限（声明的 99999 会被夹到 2000，而不是被信任）。
- 结果必须携带 `{ items, truncated, provenance }`；`items.length` 超过 `limits.maxItems` 即契约违规。
- 未声明任何 limits 的工具**不予装载**（`validateEvidenceTool` 直接报错）。

**失败语义**

| 情形 | 行为 |
|---|---|
| 请求本身超出声明上限（"把整个文件给我"） | 抛 `E_EVIDENCE_LIMIT`。**区分**：请求越界是错误；结果被截断是正常，用 `truncated: true` |
| 预算耗尽 | 抛 `E_BUDGET_EXHAUSTED`，调用方不得重试 |
| `ctx.signal` 触发 | 抛 `E_ABORTED`（或让 `throwIfAborted()` 抛出），保证不留下半截状态 |
| 领域确实不需要取证工具 | 声明 `defineEvidenceToolkit({ tools: [] })` —— **显式空是一个诚实答案**，但必须写出来 |

**装载与卸载**：领域激活（`adjudication_activate`）时才 `ctx.tools.register()` 每个证据工具，卸载时随领域的 disposer 一起注销。**任何情况下都不预热注册**——否则「按需装载」这个设计就没了。

**最小测试断言**

```js
const spec = toolkit.tools[0]
assert.ok(spec.limits.maxItems > 0 && spec.limits.maxItems <= EVIDENCE_LIMITS.hardMaxItems)
const result = await spec.execute({ nodeId: 'n1' }, { signal: new AbortController().signal })
assert.deepEqual(validateEvidenceResult(result, spec.limits), [])
```

---

### 1.4 `reviewPrompts` — P4 有界评审 + P6 独立复核（文件 `domains/<id>/prompts.js`）

**签名**

```js
export default defineReviewPrompts({
  /** P4 —— 有界评审回路的一轮 */
  review(context) {
    // context = { domain, pack, target, orientation, bundle: { key, paths, rules },
    //             ruleText, budget: { maxExcerptLines, maxSearchHits, maxToolCalls, remaining }, candidates }
    return {
      system: '……',        // 必填，非空
      rules: '……',         // 可选：通常是 engine 的 renderRules() 结果
      budget: '……',        // 可选：给模型看的预算边界文本
    }
  },
  /** P6 —— 独立复核，只看到「发现 + 证据 + 锚点」，看不到上一轮模型的推理 */
  verify(context) {
    // context = { domain, pack, target, orientation, findings }
    return {
      system: '……',        // 必填，非空：复核者角色
      instructions: '……',  // 必填，非空：如何保留 / 删除（按 lossOrientation）
    }
  },
})
```

**为什么 P4/P6 是两个函数而不是一个字符串**：现状是策略代码在跑但没有领域提示词文本；而 P6 若只复用 P4 的 prompt，就成了「同一个模型复核自己」——`critique()` 的整个意义（独立复核）会被这段文本悄悄取消。契约要求两者**文本不同**，且 `verify` 的输入**不含** P4 模型的推理过程。**CHANGED (t49)：这条要求不再是承诺，而是两道机械闸门**（见下节）。

#### 运行期：P6 现在真的会跑（CHANGED (t41)）

**修的是什么**：`reviewPrompts.verify` 曾经**全仓没有任何运行期渲染者**——`renderVerifyPrompt` 不存在，`index.js` 从不读 `reviewPrompts`，而名为「P6」的那一段（`lib/engine.js` 的 `critique()` / `runCritiquePanel()`）是**确定性的损失策略**（`lossOrientation` + 受保护主题 + `defended`/`disproved`），**一个字都不读提示词**。后果：19 个域 test.mjs 里那条「P6 文本 ≠ P4 文本」的自断言在生产路径上**永远无法触发**。这与 t17 的 `anchorVerifier` 从未被调用是同一族缺陷，因此修法是**接通运行期**，不是写进文档。

**在哪里跑**：`adjudication_submit`，顺序固定为

```
P5 锚点重算 → P6 独立复核（本次新增）→ 损失策略 runCritiquePanel（保留/删除，权威不变）→ P7 覆盖度
```

先锚定再复核：重算不成立的发现不该进入复核；复核再取舍：**P6 只产出裁决（`verdicts`），准入仍然由 `lossOrientation` 与受保护主题决定**——否则同一个旋钮会被拧两次（`lib/engine.js:549-554` 的既有理由不变）。

**独立性三条，都是机械性质而不是承诺**：

| 性质 | 怎么做到 | 怎么被断言 |
|---|---|---|
| 只看得到 findings | 上下文**逐键构造**，只含 `PROMPT_CONTEXT_FIELDS.verify` = `{domain, pack, target, orientation, findings}`；没有 `ruleText` / `bundle` / `candidates` / 预算 / 本轮工作单 | 断言 `review.verify.contextFields` 与契约字段集**逐一相等**；负向断言：把 `ruleText` / `workOrder` / P4 推理文本塞进 verdict，断言它们**没有**出现在 P6 提示词里 |
| 拿不到领域取证工具 | P6 子代理请求**显式**带 `toolFilter: { allow: [] }`（省略等于「不限制」，与 P6 需要的正好相反） | 断言 submit 结果与子代理请求里的 `toolFilter.allow` 都是空数组，且其中不含任何 `*_evidence_*` 工具名 |
| 文本与 P4 不同 | `renderVerifyPrompt` 渲染 `verify()`，`renderReviewPrompt` 渲染 `review()`；两者回退文本也是两份不同文档 | **CHANGED (t49)：两道闸门真的会拒绝**，而不是只做断言——验证期比函数身份（`validateReviewPrompts`），渲染期比**渲染结果**（`runVerify`）。19 个域实测：0/19 触发（见下节） |

#### P6 独立性的两道闸门，以及为什么是两层（CHANGED (t49)）

**修的是什么**：t14 的独立验证实测到——性质在 19 个域上**成立**（P4/P6 渲染文本逐字不等，first-diff 在第 8–33 字符，P4 的规则 canary 0/19 出现在 P6），但**没有任何东西保证它成立**：`validateReviewPrompts` 对逐字相同的两段返回 `[]`，`validateDomainPackV2` 直接委托它。于是**第 20 个领域可以不带这条性质通过两道门**。这是本队第五次撞到「被声明的性质没有被机械保证」。

**为什么是两层**：验证器拿不到上下文、渲染不了提示词——它能看见的只有**函数身份**；而「两段文本相同」是**渲染结果**的性质，只有渲染期才能看见。两层各自承重，互不遮蔽（**每一层都有一个只有它能抓到的输入**，`lib/kernel-test.mjs` §17 各驱动一次）：

| 层 | 位置 | 抓什么 | 只有它能抓的输入 | 触发时的表现 |
|---|---|---|---|---|
| 1 验证期 | `lib/contracts.js:validateReviewPrompts`（加载时，由 `validateDomainPackV2` 委托） | `review === verify`（同一个函数对象服务两个角色） | 该函数**同时**返回 `rules` 与 `instructions`：两个渲染器各取各的，渲染结果**不同**，渲染期闸门沉默，只有身份检查能抓 | 领域包被**跳过**并给出可读理由（`must be two different functions … INDEPENDENT`），永远不进注册表 |
| 2 渲染期 | `lib/reasoner.js:runVerify`（P6 渲染之后、**任何子代理启动之前**） | `renderVerifyPrompt()` 与 `renderReviewPrompt()` 在**同一份上下文**下产出**逐字相同**的文本 | 两个**不同**的函数、源码不同、却渲染出同样字符（含「把 P4 正文原样拼进 P6」这种写法） | `ok: false` / `ran: false` / `rounds: 0` / `code: 'E_P6_NOT_INDEPENDENT'` / `errors` 一条 / `verdicts: []`；子代理**一次都没启动**；报告渲染成「**P6 未启动：本领域的 P6 提示词与 P4 提示词逐字相同**」 |

**为什么渲染期是「拒绝执行」而不是「跑完再警告」**：文本就是 P4 文本的复核者，其裁决会被冠以「独立复核」之名——那比没有复核更坏。`ran` 保持 `false`（什么都没启动、预算没花；「跑过但答废了」是 t46 的 `E_VERDICT_UNPARSED`，两者必须继续可分），`ok` 为 `false` 表示这一阶段**没有成功**，`verdicts` 为空表示**不编造裁决**，准入照旧由损失取向与受保护主题决定。

**什么输入下会触发**：本节的 19 个域**一个都不触发**（t49 实测：同上下文下 19/19 渲染不同、0/19 别名、0 抛错），因此要**自造**用例来证明闸门真的会红——`lib/kernel-test.mjs` §17 有三条：不可解析的同一文本（层 2 红、层 1 绿）、单一函数服务两角色（层 1 红、层 2 绿）、以及一个**对照组**（同一形状、P6 文本真的不同 → 正常跑完、`code: 'OK'`、`ran: true`），用来排除「闸门恒亮」。


**折 verdict 到 finding 的白名单（同一处修复的另一半）**：`adjudication_submit` 把已锚定 verdict 折到 finding 上时，除既有的 `path/start/end/anchored/anchorTier/anchorVia/anchorLocator` 之外，还按白名单透传域自己的 verdict 元数据：

```
code, detail, tier, locator, scope, stale, staleCheck, ambiguousIn,
ref, refDomain, refForm, refBasis, refBasisDetail
```

**为什么必须与渲染器同时修**：`domains/requirement-alignment/prompts.js` 的 P6 正文已经在渲染 `basis=<refBasis> refDomain=<refDomain>`，而 `refDomain/refBasis/refBasisDetail` 在 `index.js` 与 `lib/*.js` 里**全仓零命中**——只接通渲染器的话，basis 恒为「(未给出)」。白名单而非展开：P4 的材料必须从 finding 上**不可达**，展开会把调用方 finding 里任何形如 `ruleText` 的键带进 P6。

**白名单是加法，不是对调用方字段的过滤（CHANGED (t46)，来自 t44 在 19 个域上的实测）**：交到 P6 的 finding 是

```
{ ...调用方原 finding 的全部字段 } + path/start/end/anchored/anchorTier/anchorVia/anchorLocator + 上面那 13 个白名单键
```

调用方自己带上的字段**一个都不会被丢掉**——t44 逐个域把「该域 P6 正文真正读的 `finding.*` 键」由调用方补齐后，P6 文本里的「未给出」占位**全部归零**（如 algo-model 2→0、product-planning 5→0、ui-visual 7→0）。反过来说：**域在自己的 verdict 上附加的键，要么由调用方在 finding 上给出，要么就不会进入 P6**（例如 `experimentId/metricName`、`strength`、`claim/nodes`、`clause`、`verified`、`token/step/graphPath`）；它们若既不在白名单里、也不在调用方 finding 上，P6 正文会看到「(未给出)」，而这是**已知且安全**的方向（宁缺勿错，不会给出比实际知道得更确定的答案）。

**扩白名单是取舍，不是待办（CHANGED (t46)）**：白名单越长，P6 越接近「看到 P4 的结论」，那正是独立性要防的东西（见上表的第 1 条性质）。因此**维持现状是刻意的决定**，不是遗漏；需要某个域侧元数据到 P6 时，正确做法是**调用方把它放进 finding**，或者明确论证它属于「锚点/归因」而不是「上一轮的结论」。

**降级语义（不许静默）**

- 宿主没有 `ctx.subagents` 也没有 `ctx.llm` → `review.verify.ran === false`，`reason` 明写「P6 只能由调用方 agent 自行完成」；报告里照样打出 P6 段并注明未执行（**缺行**与**通过**在文本上必须可区分）。
- 预算已耗尽 / 被取消 / 子代理非 `completed` → 各自给稳定 code（`E_BUDGET_EXHAUSTED` / `E_ABORTED` / `E_STOP_REASON`），**绝不当作「没有被推翻的发现」**。
- **答复无法解析（CHANGED (t46)）** → `ok: false`、`ran: true`、`code: 'E_VERDICT_UNPARSED'`、`errors` 有一条、`reason` 明说解析失败，`verdicts` 保持空数组；报告里渲染成「**未得到裁决：复核者的答复无法解析**」，**不再**打印「裁决 0 条」。理由：在 t46 之前，「复核者答非所问」（`structured === null` + 纯文本）与「复核者诚实地说没有要推翻的」（`{verdicts: []}`）产生**逐字相同**的报告（`ok: true, code: 'OK', verdicts: [], errors: [], reason: '…0 verdict(s)'`），等于把前者折叠成后者的通过。`ran` 保持 `true`（子代理真的跑了、预算真的花了，「没跑」必须仍是第三种状态）；`ok` 变 `false` 表示这一阶段**没有成功**。这不改变准入：`verdicts` 依旧为空、不编造 `keep`、不构成拒绝，取舍仍归 `lossOrientation` 与受保护主题。
- provider 不支持 `toolFilter` → `startSubagent` 丢掉该可选能力并置 `degraded: true`，在结果里可见。
- **P6 文本与 P4 文本逐字相同（CHANGED (t49)）** → `ok: false`、`ran: false`、`rounds: 0`、`code: 'E_P6_NOT_INDEPENDENT'`、`errors` 一条（含两边 `source` 与相同字符数）、`verdicts: []`；**子代理不启动**，报告渲染成「P6 未启动：本领域的 P6 提示词与 P4 提示词逐字相同」。与「未执行」（宿主没注入 `ctx.subagents`/`ctx.llm`，是环境事实）**用词与 code 都不同**：这是**领域包**的问题，把它渲染成环境事实会把包缺陷藏起来。
- 无 `reviewPrompts` 的 v1 pack 走 `legacy-verify` 兜底文本，`prompt.source` 如实标明用的不是领域自己的文本。

**机器可读面**：`adjudication_submit` 的返回值新增 `review: { kind, orientation, verify: { ran, mode, degraded, code, rounds, contextFields, prompt: { source, chars, truncated, error }, toolFilter, verdicts, errors, reason } }`。断言 P6 是否跑了，请读这个字段，不要解析 summary 文本。

**失败语义**

- prompt 函数抛异常 → 引擎回退到 v1 的 `pack.prompt`，**整条流水线不因缺提示词而失败**（`reviewPrompts` 是文本层，不是控制层）。
- 返回非字符串 / 空串 → `validatePromptOutput` 报错；引擎丢弃该字段并用 v1 兜底。
- 提示词必须是**上下文的纯函数**：同样的 `context` 必须渲染出同样的文本（prompt 前缀缓存正是靠这一点）。

**最小测试断言**

```js
const p4 = prompts.review({ bundle: { key: 'src', paths: ['a.ts'], rules: ['error-handling'] }, ruleText: 'R', orientation: 'precision-first', budget: { maxExcerptLines: 500 }, target: 'PR#1' })
assert.deepEqual(validatePromptOutput('review', p4), [])
assert.match(p4.system, /precision-first/)

const p6 = prompts.verify({ orientation: 'precision-first', findings: [{ id: 'f1', evidence: 'x' }] })
assert.deepEqual(validatePromptOutput('verify', p6), [])
assert.notEqual(p6.system, p4.system)   // P6 必须独立
```

---

### 1.5 `ruleLibrary` — P3 规则库（目录 `domains/<id>/rules/*.md`）

**签名**

```js
export default defineRuleLibrary({ dir: 'rules', load: (io) => Rule[] })  // io 由 loader 注入，领域零 import
// 或，小规模内联：
export default defineRuleLibrary({ rules: [ { name, match, text, needsExpertReview: true } ] })
```

```js
/** Rule —— 引擎 P3 的形状，v1 与 v2 完全一致 */
{ name: 'error-handling', match: ['**/*.go', '**/*.ts'], text: '……', needsExpertReview: true, source: 'error-handling.md' }
```

**`rules/*.md` 格式**（每条规则一个文件，≥20 个文件）

```markdown
---
name: error-handling
match:
  - "**/*.go"
  - "**/*.ts"
needs-expert-review: true
---

错误处理：被忽略的 error/异常返回值、被吞掉的失败分支、只记日志不返回的失败路径。
只有当变更本身引入或改变了该路径时才算；既有代码的既有问题不算。
```

- front-matter 必填：`name`（kebab-case）、`match`（非空 glob 数组）、`needs-expert-review`（**必须恰好是 `true`**）。
- 正文即 `rule.text`，≥10 字符。
- **不引入 YAML 依赖**：`parseRuleDocument` 是一个 ~40 行的最小子集解析器，只认 `key: value`、`key:` + `- item`、引号、`true/false/数字`、内联 `[a, b]`。超出的语法会被报成解析错误，而不是被静默忽略。
- 选择语义保持 v1：按**声明顺序**、首个匹配的 `match` 生效（`selectRules`）；注入的规则渲染成单个系统块（`renderRules`）。

**失败语义**

- 有效规则文件 < 20 → `validateRuleLibrary` 报错（`MIN_RULES_PER_DOMAIN = 20`）。「4 条种子规则」不是领域。
- 任何一条 `needs-expert-review !== true` → 报错。这是诚实前提的**代码级加固**。
- 规则名重复 → 报错。
- loader 读不到目录 → 抛 `E_CONTRACT`，不得返回空数组让领域"看起来还能跑"。

**最小测试断言**

```js
const rules = await loadRules(dir)
assert.ok(rules.length >= 20)
assert.ok(rules.every((rule) => rule.needsExpertReview === true))
assert.deepEqual(rules.flatMap((rule) => validateRule(rule, rule.source)), [])
```

> ⚠️ **诚实前提**：这 ≥20 条规则由 agent 起草，标注 `needs-expert-review: true`，**未经领域专家审定**。
> `RULE_PROVENANCE` 把这一点写进了代码。任何交付物（README / PR / 报告 / 提示词）都不得声称规则库已通过专家验证。

---

### 1.6 校验入口（`lib/contracts.js` 导出）

| 导出 | 作用 |
|---|---|
| `validateCandidateSource` / `validateCandidateSetResult` | P0 形状与边界 |
| `validateAnchorVerifier` / `validateAnchorVerdict` | P5 形状与 tier 合法性 |
| `validateEvidenceTool` / `validateEvidenceToolkit` / `validateEvidenceResult` / `normaliseEvidenceLimits` | P7 有界性 |
| `validateReviewPrompts` / `validatePromptOutput` | P4/P6 文本契约 |
| `parseRuleDocument` / `validateRuleDocument` / `ruleFromDocument` / `validateRule` / `validateRuleLibrary` | P3 与 front-matter |
| `validateFixture` | fixture 形状与**强制正/负锚点用例** |
| `validateDomainPackV2` | **完工闸门**：五点为空的领域在这里拿不到 `[]` |
| `checkContractIntegrity` | 常量自洽（19 个输入格式、5 个扩展点、fixture 清单…） |
| `defineCandidateSource` / `defineAnchorVerifier` / `defineEvidenceTool` / `defineEvidenceToolkit` / `defineReviewPrompts` / `defineRuleLibrary` / `defineDomainPackV2` | 装载期即校验的工厂（坏领域在加载时报错，而不是运行时） |

---

## 2. 三个「只声明未实现」的字段

现状（v1）：`bundle()` 按候选自带 `entry.key` 分组，与 `pack.bundleKey` 无关；`pack.candidateSet` 引擎根本没读；`pack.criticism.kind` 引擎根本没读。

> **状态说明**：本节给出的是**改造点与兼容策略**。`lib/contracts.js`（本轮的共享内核）已经导出这些改造所需的全部常量与函数
> （`resolveBundleKey` / `BUNDLE_KEY_STRATEGIES` / `CRITICISM_KINDS` / `DEFAULT_CRITICISM_KIND` / `GATE_FIELD_MAPPING`）；
> `index.js` 与 `lib/engine.js` 的对应改写由后续任务执行。**在此之前，三个字段仍然没有被引擎读取**——本文不声称它们已经生效。

### 2.1 `bundleKey`

**改造点（`index.js` 的 `planFor()` + `lib/contracts.js` 的 `resolveBundleKey`）**

```js
// index.js planFor()，闸门之后、bundle() 之前：
const resolved = capped.map((entry) => {
  const { key, applied } = resolveBundleKey(pack, entry, options.bundleKey)
  return applied ? { ...entry, key } : entry      // 只在解析成功时覆盖 entry.key
})
const bundleResult = bundle(resolved, { ...options.bundle, ...(pack.bundle ?? {}) })
```

`lib/engine.js` 的 `bundle()` **一行都不改**——它本来就按 `entry.key` 分组，而 key 的正确来源一直是调用方缺失的那一环。把改造放在调用方而不是引擎里，是让 43 条断言保持绿色的关键（P2 的三条断言直接调用 `bundle()`，完全不经过 `pack.bundleKey`）。

**策略表（`BUNDLE_KEY_STRATEGIES`，全部是纯函数）**

| strategy | 语义 | 例 |
|---|---|---|
| `path` | 每个候选一捆（v1 行为） | `src/a.ts` → `src/a.ts` |
| `file` | 同 `path`，领域语言用 | |
| `directory` | 路径前 `depth` 段（默认 1） | `{strategy:'directory',depth:2}`：`src/deep/a.ts` → `src/deep` |
| `extension` | 小写扩展名 | `.ts` |
| `bundleKey.resolve(candidate)` | 领域自带解析器 | 任意 |

**向后兼容策略（这是本节的核心）**

| `pack.bundleKey` 形态 | 默认行为 | 迁移开关 |
|---|---|---|
| 未声明 | 今天的行为（`entry.key ?? entry.path`），`applied: false` | 无 |
| **对象** `{ strategy, … }` | **始终生效**（v2 形态） | 无（v2 领域必须用这个形态） |
| 函数 | 始终生效 | 无 |
| **v1 字符串**（19 个内联 pack 现状：`'directory'`/`'module'`/`'flow'`/…） | **不生效**，行为与今天完全一致 | `options.bundleKeyStrategies[strategy]` 或 `options.bundleKey.trustDeclaredStrategies = true` |

也就是说：**19 个内联 pack 的分组行为在迁移前一个字都不变**。领域所有者迁到 `domains/<id>/index.js` 时改用对象形态，该领域的分组才真正生效。一个配置开关（`trustDeclaredStrategies: true`）可以一次性打开全部内联 pack 的声明语义，用于灰度验证。

工作单新增两个**只增**字段，让「策略到底生效没有」可观测：
`plan.bundleKey = { strategy, applied, reason }`，以及逐捆的 `key` 来源。未知策略名不抛异常、不猜，退回 `applied: false` 并写明 `reason`。

### 2.2 `candidateSet`

**改造点（`adjudication_plan` / `adjudicate_<id>` 工具入参 + `planFor()`）**

工具新增**可选**入参 `input`（与 `candidates` 二选一）：

```js
// 今天（保持可用）
adjudication_plan({ domain: 'code-review', candidates: [{ path: 'src/a.ts', additions: 3 }] })
// v2（新增）
adjudication_plan({ domain: 'code-review', input: { format: 'unified-diff', payload: { diff: '…' } } })
```

```js
// planFor() 分流
const pack = registry.get(domainId)
let items
if (args.input !== undefined) {
  if (typeof pack.candidateSource?.enumerate !== 'function') {
    throw new Error(`领域 ${pack.id} 尚未提供 candidateSource，请改用 candidates 入参`)
  }
  if (args.input.format !== pack.candidateSource.inputFormat) throw new Error('input.format 与领域的文档化输入格式不符')
  const enumerated = pack.candidateSource.enumerate(args.input.payload, { ...gateCtx })
  items = markSecrets(toCandidates(enumerated.candidates))   // 沿用同一条前置管线
  // enumerated.excluded / notes / truncated 一并进工作单
} else {
  items = markSecrets(toCandidates(args.candidates))         // 今天的路径，逐字未改
}
```

- `pack.candidateSet` 从「说明文字」升级为**可校验的声明**：`{ kind, inputFormat, bounded, description }`，其中 `kind` 必须等于 `candidateSource.kind`、`inputFormat` 必须等于 `candidateSource.inputFormat`（`validateDomainPackV2` 强制）。
- `candidates` 入参**保留且行为不变**：现有 `adjudication_plan` 的断言（含 e2e 那条 `plan.gate.admitted === 1`）完全不受影响；工具 schema 只是多了一个可选属性。
- 工作单新增只增字段：`plan.source = { kind, bounded, truncated, notes, excludedBySource }`。「候选集从哪来、是不是全量」必须在报告里可读——否则「我们审过了」这句话无法被审计。

### 2.3 `criticism.kind`

**改造点（`lib/engine.js` 的 `critique()` / `runCritiquePanel()` / `report()`）**

```js
// engine.js —— 唯一的逻辑改动是「读进来、回显出去」，不参与保留/删除计算
export function critique(finding, policy = {}) {
  const orientation = LOSS_ORIENTATIONS.includes(policy.orientation) ? policy.orientation : 'precision-first'
  const kind = CRITICISM_KINDS.includes(policy.kind) ? policy.kind : expectedCriticismKind(orientation)
  // …保留/删除的分支逻辑与今天逐字一致：
  //   受保护主题先否决 → minSeverity → recall-first（仅正面否定才删）/ precision-first（仅被证明才留）
  return { keep, reason, vetoed, kind }        // 只多一个 kind 字段
}

// runCritiquePanel：结果里多一个 kind: <criticism.kind>
// report()：多一个 criticismKind 字段；summary 里多一行「复核者：事实核查 / 分级筛选」
// index.js submit：runCritiquePanel(anchored, { orientation, kind: pack.criticism?.kind, protectedSubjects })
```

**关键决定：`kind` 不进损失计算。**

`lossOrientation` 才是决定保留/删除的那个旋钮（README 专门用一节强调它是「最危险的一个」）。`criticism.kind` 指的是**复核者的形态**——`fact-checker`（对抗式事实核查：默认不成立，除非证据证明）还是 `triage`（分级筛选：不删除，只标注并保留存疑）。把 kind 接到保留/删除的数学上，会改变已发布 pack 的行为、直接打掉 P6 的 5 条断言，而且等于把同一个旋钮装两遍。

**为什么可以把它写成不变量**：19 个 pack **无例外**地满足这条对应关系——9 个 recall-first（`risk-compliance`/`data-engineering`/`tech-test`/`operator-design`/`requirement-research`/`market-research`/`reverse-engineering`/`user-feedback`/`requirement-alignment`）全部声明 `triage`；10 个 precision-first 全部声明 `fact-checker`。所以 `DEFAULT_CRITICISM_KIND = { 'precision-first': 'fact-checker', 'recall-first': 'triage' }` 是对既成事实的**形式化**，不是新规则。v2 的 `validateDomainPackV2` 把不一致判为**问题**（v2 领域必须修声明，而不是改引擎）；v1 的 `validateDomain` **一字不改**，因此 43 条断言不受影响。

### 2.4 兼容性总表：三项改动对既有断言的影响

| 改动 | 落点 | 断言风险 | 为什么安全 |
|---|---|---|---|
| `bundleKey` 生效 | `index.js planFor()` 调用 `resolveBundleKey` 后再 `bundle()` | 0 | 字符串形态默认不生效；`bundle()` 未改；P2 三条断言直接调 `bundle()` |
| `candidateSet` / `candidateSource` | 工具新增可选 `input` 入参；`candidates` 路径原样 | 0 | 只增字段；旧入参逻辑逐字保留 |
| `criticism.kind` | `critique()` 返回多一个 `kind`，`report()` 多一个 `criticismKind` | 0 | 断言只检查 `kept`/`dropped`/`vetoes`/`critique`/`domain`/`lossOrientation`/`unanchored`/`summary` 正则，均为只增 |

**验证命令**（三项改造落地后必须原样通过）：

```bash
npm test        # 期望：34 条契约自检 + 49 条运行时自检 + 43 passed, 0 failed + 13 条真实 Cordis 检查全过
```

---

## 3. P4 有界推理回路用哪个 DSH 服务

> **状态说明**：本节是选型与接线契约，**尚未落地**。当前 `index.js` 仍然不调用任何模型——P4 回路完全甩给调用方 agent。
> 本轮交付的是「用哪个服务、怎么注入、预算与取消怎么走」的确定答案，代码接线由后续任务执行。

### 3.1 决定

**主路径 `ctx.subagents`（`SubagentRuntime.start`），兜底路径 `ctx.llm.stream`，两者都可缺席。**

理由不是「哪个更好用」，而是 P4 的四项硬需求正好是 `SubagentStartRequest` 的现有字段，而 `ctx.llm` 一项都不提供：

| P4 需求 | `ctx.subagents` | `ctx.llm` |
|---|---|---|
| 独立上下文（不带主会话历史） | ✅ 子 agent 自带独立 session | ❌ 得自己拼 `messages`，自己承担隔离 |
| 工具白名单（只能调本领域证据工具） | ✅ `toolFilter`（子 agent 里不可见且拒绝执行） | ❌ **没有工具循环** |
| 结构化产出（findings 必须能被重算锚点） | ✅ `outputSchema` → `result.structured` | ❌ 只能拿到流式文本，还得自己解析 |
| 可取消 | ✅ `signal: exec.signal` | ✅ `signal` |
| 深度上限（防止子 agent 再开子 agent 爆炸） | ✅ `maxDepth` | ➖ 无此概念 |

用 `ctx.llm` 实现 P4，等于自己重写工具循环 + 上下文隔离 + 输出校验——那正是当前「把有界回路甩给调用方 agent」的复演。

**`ctx.llm` 并没有被丢弃，它有两个不可替代的用途**：

1. **C 探索型领域（`market-research` / `reverse-engineering`）的「找候选」一轮**：这一步不需要工具循环，且成本上界**本来就不可承诺**，一次非工具化补全更诚实，也更便宜。
2. **`subagents` 缺席时的降级**：只跑单轮、无工具，把产出标成 `degraded: true` 并计入报告——**不静默降级**。

### 3.2 注入必须是可选的（`ctx.inject`，不是静态 `inject`）

```js
export const inject = ['tools']            // 保持原样，一个字都不加

export function apply(ctx, config) {
  // …
  let subagents; let llm
  ctx.inject(['subagents'], (subCtx) => {
    subagents = subCtx.subagents
    subCtx.effect(() => () => { subagents = undefined }, 'adjudication.p4()')
  })
  ctx.inject(['llm'], (llmCtx) => {
    llm = llmCtx.llm
    llmCtx.effect(() => () => { llm = undefined }, 'adjudication.p4-fallback()')
  })
}
```

**为什么绝不能写进静态 `inject`**：静态 `inject: ['tools','subagents']` 在宿主没有 `subagents` 服务时会让整个 fiber 失败，Cordis 会**回滚这个插件刚注册的全部工具**——表现是「挂载成功然后悄悄消失」。这与 README「已知问题」里那条 `ctx.set` 教训是同一类事故，只是触发条件从「set 未 provide」换成「inject 未 provide」。既有的 `ctx.inject(['systemPrompt'], …)` 已经是这个模式的先例，照着写即可。

### 3.3 尊重 budget

```js
// 预扣，而不是事后对账（与 engine 的 charge() lookahead 语义一致）
const rounds = Math.max(0, Math.floor(ledger.settings.maxToolCalls / pack.evidenceTools.tools.length || 1))
ledger = charge(ledger, { toolCalls: 1, text: systemPrompt + ruleText })
if (ledger.exhausted) {
  return { ok: false, code: E_BUDGET_EXHAUSTED, skipped: remainingBundles,
           note: '预算耗尽：未启动的批次已记入报告，未静默丢弃' }
}
```

规则：

- 每次子运行**前**扣一次 `charge()`；`budget.exhausted` 为真时**不得启动**新的回路。
- 未启动的批次进报告（`skipped`），并让 `coverageProof.complete === false`。recall-first 领域据此判定**未通过**（现有 `adjudication_submit` 已有这条逻辑）。
- 子 agent 的每次工具调用也要在它返回后按实际次数并入 ledger（`charge(ledger, { toolCalls: n })`）。

### 3.4 可取消（转发 `exec.signal`）

```js
async function runBoundedPass(bundle, exec) {
  exec.signal?.throwIfAborted()
  const run = await subagents.start({
    label: `adjudicate ${pack.id} ${bundle.key}`,
    parent: exec.agent,                          // 来自工具 exec 上下文，不是 ctx
    prompt: [{ type: 'text', text: p4.system + '\n\n' + p4.rules }],
    signal: exec.signal,                         // ★ 原样转发：用户中断即刻传导到子 agent
    outputSchema: FINDINGS_SCHEMA,
    toolFilter: { allow: pack.evidenceTools.tools.map((t) => evidenceToolName(pack.id, t.name)) },
    maxDepth: /* 当前深度 */,
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      return { ok: false, code: result.stopReason === 'aborted' ? E_ABORTED : E_CONTRACT,
               diagnostic: result.diagnostic }
    }
    return { ok: true, findings: result.structured ?? parseTextFindings(result.output) }
  } finally {
    await run.dispose()        // 契约要求：一次性的 run 必须 dispose，否则子 agent 不静默
  }
}
```

- `SubagentResult.stopReason !== 'completed'` **一律视为该批次失败并计入报告**，不得当成「没有发现」。`aborted` → `E_ABORTED`。
- `SubagentRun.result` 不会因模型/传输故障 reject（它会以 `stopReason: 'error'` resolve）；只有基础设施故障才 reject——那条路径也要 `dispose()`。
- 能力协商：`outputSchema` / `toolFilter` 需要 provider 具备对应 capability（`SubagentCapabilities`），不被支持时 `start()` 会**明确拒绝**。这时降级为「不带 schema / 不带 toolFilter 的一次性子运行」并在报告里标注，而不是静默丢掉这两个保护。
- C 探索型的 `ctx.llm` 路径同样转发 `signal`：`ctx.llm.stream({ provider, model, system, messages, signal: exec.signal })`。

---

## 4. 领域包的组织方式与自动发现

> **状态说明**：`domains/` 目录与 `lib/domain-loader.js` **尚未创建**；本节是布局与发现契约。
> 现状是 19 个 pack 全在 `lib/domains.js` 一个 868 行的文件里——那是这一节要消灭的写冲突源。

### 4.1 目录布局（每个领域所有者只写自己的目录）

```
dsh-adjudication/
├─ index.js                 # 插件：核心 6 工具 + 按需装载（既有，改动仅限 §2 的落点）
├─ lib/
│  ├─ engine.js             # 域无关确定性原语（既有，bundle() 不改）
│  ├─ registry.js           # 注册表（既有，v1 校验一字不改）
│  ├─ domains.js            # v1 内联库：19 个 pack，冻结为参照物
│  ├─ contracts.js          # ★ v2 契约：常量 / 工厂 / 校验器
│  └─ domain-loader.js      # ★ v2 自动发现与装载（本契约的消费方）
└─ domains/
   ├─ index.js              # 装载器入口：扫描同层目录并 registerAll
   └─ <id>/
      ├─ index.js           # pack v2（default export）
      ├─ source.js          # candidateSource
      ├─ anchor.js          # anchorVerifier
      ├─ evidence.js        # evidenceTools
      ├─ prompts.js         # reviewPrompts
      ├─ rules/*.md         # ≥20 条，front-matter 带 needs-expert-review: true
      ├─ fixtures/*.json    # 至少 empty / all-gated-out / happy-path
      └─ test.mjs           # 对 fixture 跑 P0→P7
```

**为什么必须拆目录**：今天 19 个 pack 全在 `lib/domains.js` 一个 868 行的文件里——19 个领域所有者改同一个文件，是必然会发生的写冲突。v2 之后，一个领域的全部内容（源、锚点、证据、提示词、规则、夹具、测试）都在 `domains/<id>/` 下，**没有任何跨领域共享文件需要编辑**。

`contracts.js` 里 `DOMAIN_FILE_LAYOUT.shared` 明确列出**领域所有者不得编辑**的文件：`domains/index.js` 与 `lib/domains.js`（后者冻结为 v1 参照物）。

### 4.2 自动发现契约

> **本节与实现逐字对齐**（`lib/domain-loader.js` 的实际导出与签名）。t3 审查指出本节早先的版本
> 写的是 `loadDomain(io, id)` 与 `skipped: string[]`，与实现不符。
> **选择：改文档对齐实现**，理由有三 ——
> ① `index.js` 已经在消费实现的形状（`directory.skipped[].id`、`registerLoadedDomains(registry, result)`），
> 改实现会牵动已验收的路径；
> ② `loadDomain(io, id)` 会让装载器从 id 反推目录，丢掉 `root` 这一层间接（多根装载、测试夹具都依赖它）；
> ③ `skipped: string[]` 会丢掉原因，而「为什么被跳过」正是这套机制最需要说清楚的东西。
> 实现的形状对领域拥有者更有用，所以文档向它看齐。

```js
// lib/domain-loader.js —— 形状由本契约固定，本清单与该文件的实际导出逐字对齐
export const DEFAULT_DOMAIN_ROOT = 'domains'
export const EXTENSION_FILES = { candidateSource: 'source.js', anchorVerifier: 'anchor.js',
                                 evidenceTools: 'evidence.js', reviewPrompts: 'prompts.js' }
export const IGNORED_DIRECTORY_NAMES = ['index.js', 'node_modules']

// —— 唯一的 skipped 条目形状（扫描级与领域包级共用，见 4.2.1）——
export const SKIPPED_ENTRY_KEYS = Object.freeze(['id', 'reason'])
export function validateSkippedEntry(value, where)   // -> string[]（problems）
export function validateSkippedEntries(entries, where) // -> string[]

// —— io 注入：模块本身不 import node:fs ——
export function createMemoryIo(files)                 // { path: contents } -> io（测试用，纯内存）
export async function createNodeIo(options)           // { root | baseUrl } -> io（内部动态 import node: 内置模块）

// —— 发现与装载 ——
/** @returns {{ root: string, found: Array<{id,dir}>, skipped: Array<{id,reason}>,
 *              problems: Array<{id,problems:string[]}> }} */
export function discoverDomains(io, options)          // options: { root, ignored }

/** 一个领域目录：index.js + source/anchor/evidence/prompts + rules/ + fixtures/ */
/** @returns {Promise<{ pack?: object, problems: string[], files: string[] }>} */
export async function loadDomain(io, entry, options)  // entry: { id, dir }；options: { loadModule, rulesDir }

/** 发现 + 逐个装载；重名按 id 拒绝，第二个出现者被跳过 */
/** @returns {Promise<{ root, packs, problems: Array<{id,problems}>,
 *                       skipped: Array<{id,reason}>, loaded: Array<{id,files}> }>} */
export async function loadDomains(io, options)        // options: { root, strict, loadModule, claimed, rulesDir }

export function loadRules(io, directory)              // -> { rules: Rule[], problems: string[] }

/** 把装载结果注册进注册表；同 id 覆盖 v1 pack（这就是迁移路径） */
export function registerLoadedDomains(registry, result, options) // -> { disposers, replaced, added }

// —— 诊断与规则自检 ——
export function describeDomainDirectory(result)       // -> string（给 adjudication_domains 的摘要）
export function inspectRuleDocument(text, filename)   // -> { frontMatter, body, problems }
```

#### 4.2.1 `skipped` 条目的形状（t3 R1）

**扫描级与领域包级使用同一个键集合**，不存在两套：

| 级别 | `id` 是什么 | 例 |
|---|---|---|
| 目录扫描级 | 那个目录项的名字 | `{ id: 'stray.txt', reason: 'not a directory' }` |
| 领域包级 | **声明的领域 id**（不是目录路径） | `{ id: 'demo', reason: 'invalid v2 pack (3 problems)' }` |
| 重名拒绝 | 被重复声明的 id | `{ id: 'demo', reason: 'duplicate domain id rejected (already declared by "roots/a/demo")' }` |

所以 `result.skipped.map((entry) => entry.id)` 永远有意义，领域拥有者写断言时不需要问
「这条是扫描级还是包级」。重名那条的 `id` 是**重复的 id**而不是目录，这样按 id 过滤时
看到的值与注册表里的一致；两个目录的路径写在 `reason` 里。

`problems` 是**另一种**形状（`{ id, problems: string[] }`），因为它要携带**多条**诊断。
它是列表而不是单条字符串，这是有意的：一个非法领域往往同时违反好几条契约。

```js
// 一行锁住形状（领域 test.mjs 可直接用）
assert.deepEqual(validateSkippedEntries(result.skipped), [])
```

> **别和另一个 `skipped` 混淆。** 全仓有**两个**叫 `skipped` 的字段，含义不同、形状不同：
> • 本节这个 —— `loadDomains()/discoverDomains()` 的 `skipped`，**`{id, reason}[]`**，回答「哪个领域目录没被装载，为什么」；
> • `lib/reasoner.js` 的 `run()` 返回的 `skipped` —— **`string[]`**，是**没跑到的批次 key**，回答「预算耗尽/被取消时哪些捆没做」。
> 前者是诊断，后者是**未覆盖声明**（recall-first 领域据此判未通过）。两者的形状都固定，不得互换。

装配规则：

1. 扫描 `domains/`（`options.root`）下的目录，每个目录名即候选 `id`（`^[a-z][a-z0-9-]*$`）。
2. `import(<dir>/index.js)` 拿 `default`；`contractVersion !== 2` 或 `validateDomainPackV2` 非空 → 按 `strict` 决定**抛错**（内置库语义）或**跳过并告警**（第三方语义），与既有 `registry` 的 `strict` 语义一致。
3. 逐个尝试从 `source.js` / `anchor.js` / `evidence.js` / `prompts.js` 补齐扩展点；`index.js` 里显式声明的优先，声明与文件同名时以声明为准。
4. `pack.ruleLibrary` 未声明时扫 `rules/*.md`；声明了 `load(io)` 时把**同一个 io** 交给领域，领域模块因此**不需要也不允许 import `node:fs`**。
5. `registerLoadedDomains()` 返回一个总 disposer（沿用 `createRegistry` 的契约），并区分 `added` / `replaced`。
6. **v1 与 v2 并存**：`lib/domains.js` 的 19 个 pack 仍然是默认库；`domains/<id>/` 中同 id 的 v2 pack **覆盖**它（注册表按 id 后写覆盖），迁移期可以一个领域一个领域地切。
7. `npm test` 需要把 `domains/*/test.mjs` 纳入（见 §6）。
8. **零依赖的准确表述**：`lib/domain-loader.js` 有且只有一个静态 import —— `./contracts.js`（相对同级、自身无 import）。它不 import 任何第三方包，也不静态 import `node:fs`/`node:path`/`node:url`；真实文件系统访问由 `createNodeIo()` 在工厂内部**动态**取得，或完全由宿主注入 `io` 绕开。

---

## 5. 十九个领域的「文档化输入格式」与 fixture 清单

> 真实系统对接不在本轮范围；但格式具体到**可以照着写适配器与 fixture**。
> 机器可读版本：`DOMAIN_INPUT_FORMATS`（`lib/contracts.js`），`checkContractIntegrity()` 保证 19 个条目齐全。
> 每个领域**强制**包含 `empty`、`all-gated-out`、`happy-path` 三个 fixture，另有领域专属条目。

### 5.0 总览

| # | id | 家族 | format | 候选集单位（P0） | 有界 |
|---|---|---|---|---|---|
| 1 | `code-review` | A | `unified-diff` | (文件, hunk) | ✅ |
| 2 | `risk-compliance` | A | `clause-and-surface` | (条款, 受审面) 对 | ✅ |
| 3 | `ux-review` | A | `flow-spec` | (步骤, 分支) + 分支种类 | ✅ |
| 4 | `ui-visual` | A | `design-tokens-and-layers` | (图层, 属性) | ✅ |
| 5 | `architecture` | A | `module-graph-and-adr` | 依赖边 + (ADR, 模块) | ✅ |
| 6 | `data-engineering` | A | `lineage-and-schema` | 血缘边 + (节点, 字段) | ✅ |
| 7 | `algo-model` | A | `experiment-record` | (实验, 指标) | ✅ |
| 8 | `tech-test` | A | `test-inventory-and-coverage` | 未覆盖行/分支 + 弱断言用例 | ✅ |
| 9 | `tech-doc` | A | `doc-corpus-and-api-surface` | (段落, 可验证断言) | ✅ |
| 10 | `operator-design` | A | `operator-registry-and-tests` | (算子, 后端, dtype, 形态) | ✅ |
| 11 | `requirement-research` | B | `interview-corpus` | 每一句原话 | ✅ |
| 12 | `product-planning` | B | `requirement-registry-and-plan` | (方案, 需求) 边 + 孤儿 | ✅ |
| 13 | `backend-engineering` | B | `unified-diff` | (文件, hunk) | ✅ |
| 14 | `frontend-engineering` | B | `unified-diff` | (文件, hunk) | ✅ |
| 15 | `market-research` | C | `research-seed` | **种子来源**（不是枚举） | ❌ |
| 16 | `reverse-engineering` | C | `artifact-and-observations` | 每条观察 | ❌ |
| 17 | `project-management` | D | `task-graph` | 依赖边 + 任务节点 | ✅ |
| 18 | `user-feedback` | D | `feedback-ledger` | 每条反馈 | ✅ |
| 19 | `requirement-alignment` | D | `trace-graph` | 每条追溯边 + 悬空侧 | ✅ |

**闸门字段映射（全领域统一规则）**：候选不是文件时，`path` 用合成长 id（如 `surface/data-flow-3`、`layer/L12`），而领域自己的排除信号按 `GATE_FIELD_MAPPING` 映射：不可读 → `binary`，已撤回/归档 → `deleted`，超长 → `bytes`。**`secretMatch` 不得由 source 设置。** 这条统一规则让「全被闸门排除」这个边界 fixture 在 19 个领域里都写得出来。

### 5.1 逐领域规格

#### 1. `code-review` —— `unified-diff`

```json
{ "format": "unified-diff",
  "payload": { "diff": "diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,3 @@\n…",
               "files": [{ "path": "src/a.ts", "bytes": 812, "binary": false, "deleted": false, "additions": 12, "deletions": 3 }] } }
```
- **适配器**：`git diff --unified=3 --no-color <base>...<head>`；`files[]` 由 `git diff --numstat` + `--name-status` 补齐。
- **候选**：每个 (文件, hunk)；`locator = { hunkIndex, startLine, endLine }`；`path` = 文件路径（闸门按文件粒度判定，与 OCR 一致）。
- **闸门映射**：二进制/不可读 → `binary`；删除的文件 → `deleted`；文件体积 → `bytes`。
- **fixtures**：`empty`（空 diff）、`all-gated-out`（只有 `node_modules/x/index.js` + `.env` + 二进制 + 已删除文件）、`happy-path`（2 文件 3 hunk）、`renamed-file`（重命名 + 内容微调）。

#### 2. `risk-compliance` —— `clause-and-surface`

```json
{ "format": "clause-and-surface",
  "payload": { "clauses": [{ "id": "GDPR-5-1-c", "title": "数据最小化", "text": "…", "appliesTo": ["surface/data-*"] }],
               "surface": [{ "id": "data-flow-3", "type": "data-flow", "path": "surface/data-flow-3",
                             "description": "订单画像 → 第三方广告 SDK", "evidence": "…", "withdrawn": false }] } }
```
- **适配器**：制度条款从策略仓库按文件导出一份 JSON（每条一款）；受审面来自数据流 / 权限边 / 对外接口 / 留存策略 / 日志内容的清单。
- **候选**：每个 `appliesTo` 命中的 (条款, 受审面) 对；`locator = { clauseId, surfaceId }`。**双锚点**：条款 ID（规则侧）+ 证据原文（受审侧）。
- **闸门映射**：只有 `.md` 的条款转储 → `path` 命中 `**/*.md` 排除；已脱敏的面 → `binary`；已退役 → `deleted`。
- **fixtures**：`empty`（无条款或无面）、`all-gated-out`（全部面被 `**/*.md` 排除 / 全部退役）、`happy-path`（2 条款 × 3 面 → 4 对）、`unmatched-clause`（条款有、面没有 → 进 `notes`，不得静默消失）。

#### 3. `ux-review` —— `flow-spec`

```json
{ "format": "flow-spec",
  "payload": { "flow": { "id": "checkout", "name": "结算", "steps": [{ "id": "s1", "name": "填地址", "type": "form", "next": ["s2"], "onError": "e1" }] },
               "branches": [{ "id": "b-normal", "kind": "normal", "steps": ["s1","s2"] }, { "id": "b-empty", "kind": "empty", "steps": [] }],
               "prototype": { "nodes": [{ "id": "n1", "name": "地址表单", "screen": "checkout" }] } } }
```
- **候选**：每个 (步骤, 分支) 加每个声明的分支种类；`locator = { stepId, branchId, nodeId? }`。分支种类必须覆盖正常 / 错误 / 中断 / 回退 / 空态 / 首用态。
- **闸门映射**：已归档步骤 → `deleted`；纯图片节点 → `binary`；超大画板 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`undeclared-branch`（步骤引用了未声明的 `onError` 目标）。

#### 4. `ui-visual` —— `design-tokens-and-layers`

```json
{ "format": "design-tokens-and-layers",
  "payload": { "tokens": { "spacing": { "space-4": { "value": "16px" } }, "color": { "text-primary": { "value": "#111827" } } },
               "layers": [{ "id": "L12", "name": "Card/Padding", "type": "frame",
                            "props": { "padding": "17px", "color": "#FFFFFF" }, "tokenRefs": { "color": "color/text-primary" }, "archived": false }] } }
```
- **候选**：每个属性值**不是 token 引用**的 (图层, 属性)；`locator = { layerId, prop, tokenName? }`。
- **闸门映射**：归档图层 → `deleted`；位图层 → `binary`；导出体积 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`hardcoded-value`（硬编码 `#FFF`，应指向 `color/text-primary`）。

#### 5. `architecture` —— `module-graph-and-adr`

```json
{ "format": "module-graph-and-adr",
  "payload": { "modules": [{ "id": "core", "path": "src/core", "dependsOn": ["infra"] }],
               "adrs": [{ "id": "ADR-0007", "title": "内层不依赖外层", "status": "accepted", "decision": "…", "affects": ["core"] }] } }
```
- **候选**：每条依赖边，加每个 (ADR, 受影响模块) 对；`locator = { moduleId, targetId?, adrId? }`。声明方向违规必须能被依赖图验证。
- **闸门映射**：仅测试模块 → `path` 命中 `**/test/**` 排除；生成代码 → `binary`；已移除模块 → `deleted`。
- **fixtures**：`empty`、`all-gated-out`（全部模块路径落在 `**/test/**`）、`happy-path`、`cycle`（环 + 具体路径）。

#### 6. `data-engineering` —— `lineage-and-schema`

```json
{ "format": "lineage-and-schema",
  "payload": { "nodes": [{ "id": "n1", "type": "transform", "inputs": ["raw.orders"], "outputs": ["dwh.order_facts"], "path": "dags/orders.py", "sql": "select …" }],
               "schema": { "raw.orders": { "columns": [{ "name": "amt", "type": "decimal(12,2)", "nullable": true }] } },
               "runs": [{ "nodeId": "n1", "status": "ok", "at": "2026-09-30T02:00:00Z" }] } }
```
- **候选**：每条血缘边，加每个「空值/类型正在变化」的 (节点, 字段)；`locator = { nodeId, table, column }`。
- **闸门映射**：测试用 dag → `path` 排除；二进制快照 → `binary`；已删除表 → `deleted`。
- **fixtures**：`empty`、`all-gated-out`（全部节点在 `**/test/**`）、`happy-path`、`orphan-column`（引用了 schema 里不存在的字段 → 必须产出**未锚定**而不是猜）。

#### 7. `algo-model` —— `experiment-record`

```json
{ "format": "experiment-record",
  "payload": { "experiments": [{ "id": "exp-42", "name": "rerank-v3", "seed": 7,
                                 "dataset": { "train": "ds://t1", "valid": "ds://v1", "test": "ds://te1", "splitsHash": "sha256:…" },
                                 "metrics": [{ "name": "ndcg@10", "value": 0.412, "definition": "…", "ci": [0.401, 0.423] }],
                                 "baseline": { "id": "exp-40", "metrics": [{ "name": "ndcg@10", "value": 0.398 }] },
                                 "hyperparams": { "lr": 0.001 }, "budget": { "steps": 20000, "gpuHours": 12 } }] } }
```
- **候选**：每个 (实验, 指标)；`locator = { experimentId, metricName }`。核心是**评估口径可复现性**。
- **闸门映射**：已取消的 run → `deleted`；权重/产物 → `binary`；超大日志 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`missing-baseline`（无对照 → 结论不成立）。

#### 8. `tech-test` —— `test-inventory-and-coverage`

```json
{ "format": "test-inventory-and-coverage",
  "payload": { "cases": [{ "id": "t-12", "file": "tests/orders.test.ts",
                           "assertions": [{ "kind": "nonnull", "target": "res" }] }],
               "coverage": { "files": { "src/orders.ts": { "lines": { "12": 1, "13": 0 }, "branches": { "3": [1, 0] } } } },
               "source": { "src/orders.ts": { "lines": ["export function sum(items) {", "  return items.reduce((a,b)=>a+b, 0)"] } } } } }
```
- **候选**：每个未覆盖的行/分支，加每个弱断言（`nonnull`/`snapshot`）用例；`locator = { caseId?, path, line?, branch? }`。
- **闸门映射**：生成的测试文件 → `path` 排除；快照 → `binary`；已删除的套件 → `deleted`。
- **fixtures**：`empty`（无用例且无覆盖率报告）、`all-gated-out`、`happy-path`、`zero-coverage-file`（整文件 0 覆盖 → recall-first 下必须全部暴露）。

#### 9. `tech-doc` —— `doc-corpus-and-api-surface`

```json
{ "format": "doc-corpus-and-api-surface",
  "payload": { "documents": [{ "path": "docs/api.md", "title": "API",
                               "sections": [{ "anchor": "usage", "text": "调用 `sum(items, {round: true})` 返回数字。见 [限制](./limits.md#top)" }] }],
               "api": [{ "name": "sum", "signature": "sum(items: number[], opts?: {round?: boolean}): number",
                         "params": [{ "name": "items", "required": true }, { "name": "opts", "required": false, "default": "{}" }], "returns": "number" }] } }
```
- **候选**：每个 (段落, 可验证断言)；断言 = 签名形状字符串 / 围栏代码块 / 相对链接；`locator = { docPath, anchor, apiName? }`。
- **闸门映射**：生成的文档 → `path` 排除；图片 → `binary`；已删除页面 → `deleted`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`broken-relative-link`（指向不存在的文件 → 未锚定，不得判为"文档问题"）。

#### 10. `operator-design` —— `operator-registry-and-tests`

```json
{ "format": "operator-registry-and-tests",
  "payload": { "operators": [{ "signature": "softmax(Tensor, dim)", "name": "softmax", "backends": ["cpu","cuda"],
                               "dtypes": ["fp16","fp32"], "shapeBranches": ["empty","single","broadcast"] }],
               "tests": [{ "operator": "softmax", "backend": "cuda", "dtype": "fp16", "shape": "broadcast",
                           "tolerance": { "atol": 1e-3, "rtol": 1e-2 }, "asserted": true }] } }
```
- **候选**：每个 (算子, 后端, dtype, 形态分支)；`locator = { signature, backend, dtype, shapeBranch }`。一个实现的一个形态就是一个候选。
- **闸门映射**：未构建的内核 → `deleted`；二进制产物 → `binary`；生成代码过大 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`missing-tolerance`（某形态无容差断言 → recall-first 下必须保留）。

#### 11. `requirement-research` —— `interview-corpus`

```json
{ "format": "interview-corpus",
  "payload": { "sessions": [{ "id": "iv-3", "participant": { "id": "p7", "role": "运营" }, "startedAt": "2026-08-02T09:12:00+08:00",
                             "utterances": [{ "t": "00:04:31", "speaker": "p7", "text": "现在导出一次要等十分钟", "redacted": false, "withdrawn": false }] }],
               "notes": [] } }
```
- **候选**：每一句原话（候选是**原话**，不是需求——需求是它的加工产物）；`locator = { sessionId, utteranceIndex, t }`。
- **闸门映射**：脱敏句 → `binary`；撤回授权 → `deleted`；超长turn → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`contradictory-pair`（两位受访者矛盾 → 必须**同时保留**，不得取平均）。

#### 12. `product-planning` —— `requirement-registry-and-plan`

```json
{ "format": "requirement-registry-and-plan",
  "payload": { "requirements": [{ "id": "REQ-11", "title": "导出提速", "status": "confirmed", "sourceQuoteId": "iv-3#12" }],
               "plans": [{ "id": "PL-4", "title": "异步导出", "serves": ["REQ-11"],
                           "metric": { "name": "p95 导出耗时", "baseline": 600, "target": 60, "window": "30d" },
                           "deps": [], "risks": [] }] } }
```
- **候选**：每个 (方案, 需求) 边，加两侧的孤儿；`locator = { planId, requirementId? }`。**每条方案必须挂回至少一条已确认需求。**
- **闸门映射**：未确认需求 → `deleted`；附件 → `binary`；超大规格 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`orphan-both-sides`（孤儿需求 + 孤儿方案各 1）。

#### 13. `backend-engineering` —— `unified-diff`（+ 服务映射）

与 `code-review` 同一格式，多一个可选 `serviceMap`：
```json
{ "format": "unified-diff", "payload": { "diff": "…", "files": [ … ], "serviceMap": { "src/orders/**": "orders-svc" } } }
```
- **候选 / locator / 闸门映射**：同 `code-review`（`locator = { hunkIndex, startLine, endLine }`）；闸门额外排除生成的 protobuf 产物。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`proto-field-removed`（删除 proto 字段 → 契约破坏）。

#### 14. `frontend-engineering` —— `unified-diff`（+ 打包报告）

```json
{ "format": "unified-diff", "payload": { "diff": "…", "files": [ … ], "bundleReport": { "main": 512000, "vendor": 1800000 } } }
```
- **候选 / locator / 闸门映射**：同 `code-review`；闸门额外排除构建产物与 source map。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`css-only-change`（只改 CSS → 不触发渲染规则）。

#### 15. `market-research` —— `research-seed`（**C 探索型，`bounded: false`**）

```json
{ "format": "research-seed",
  "payload": { "question": "国内企业级 RAG 采购预算区间？", "scope": { "market": "企业 RAG", "geo": "CN", "horizon": "2026" },
               "seedSources": [{ "url": "https://example.com/report", "title": "…", "retrievedAt": "2026-09-01",
                                 "snippet": "…", "withdrawn": false }] } }
```
- **候选**：每条种子来源。**这是种子，不是枚举**：`bounded: false` 是强制的，且必须带一条 `notes` 说明「候选集本身要找」。加宽一轮属于 C 家族的探索步骤，**不属于 P0**。
- **闸门映射**：非 http(s) → 命中 `extension`；已撤回 → `deleted`；付费墙正文 → `bytes`。
- **锚点**：`{ url, quote }`，`verify: 'externally-recheckable'`（引擎**无法**验证外部网页内容，可复核等级低于 A 类，必须显式标注）。
- **fixtures**：`empty`（种子表为空 → 合法，产出「需要先做一轮来源发现」的工作单）、`all-gated-out`（全部非 http / 全部撤回）、`happy-path`、`non-http-source`。

#### 16. `reverse-engineering` —— `artifact-and-observations`（**C 探索型，`bounded: false`**）

```json
{ "format": "artifact-and-observations",
  "payload": { "artifacts": [{ "id": "art-1", "path": "firmware/app.bin", "sha256": "…", "kind": "firmware",
                               "obtainedBy": "厂商固件包", "authorisation": "内部授权 RE-2026-01" }],
               "observations": [{ "id": "obs-7", "artifactId": "art-1",
                                  "steps": ["注入 0x40 长度帧", "观察返回码"], "observed": "返回 0x02 并回显长度", "verified": false }] } }
```
- **候选**：每条观察；候选集随探索扩大，`bounded: false` + note 强制。
- **闸门映射**：`.git` 下的产物 → `default-path`；不透明 blob → `binary`；产物缺失 → `deleted`。
- **fixtures**：`empty`、`all-gated-out`（全部产物在 `**/.git/**`）、`happy-path`、`unverified-observation`（`verified: false` → 必须标猜想，不得当作结论）。

#### 17. `project-management` —— `task-graph`

```json
{ "format": "task-graph",
  "payload": { "tasks": [{ "id": "T-1", "title": "…", "owner": "alice", "estimateDays": 3, "status": "open", "dependsOn": ["T-0"] }],
               "milestones": [{ "id": "M-1", "due": "2026-11-01", "tasks": ["T-1"] }],
               "risks": [{ "id": "R-1", "trigger": "…", "impact": "…", "mitigation": "…" }] } }
```
- **候选**：每条依赖边，加每个任务（节点在图中的位置）；`locator = { taskId, from?, to? }`。**产物是一致性本身**。
- **闸门映射**：归档任务 → `deleted`；只有附件的任务 → `binary`；超大任务体 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`cycle-and-orphan`（环 + 孤儿任务，必须给出**具体路径**而不是"耦合高"）。

#### 18. `user-feedback` —— `feedback-ledger`

```json
{ "format": "feedback-ledger",
  "payload": { "feedback": [{ "id": "FB-88", "channel": "工单", "receivedAt": "2026-09-12",
                              "verbatim": "批量导入 500 条就卡死", "status": "open",
                              "decision": { "reason": "…", "decidedAt": "…" } }] } }
```
- **候选**：每条反馈；`locator = { feedbackId, quote }`（原话逐字）。
- **闸门映射**：标记为垃圾/重复 → `deleted`；附件 → `binary`；超长会话 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`unclosed-only`（只有 `status: "open"` → recall-first 下必须全部暴露）。

#### 19. `requirement-alignment` —— `trace-graph`（元领域）

```json
{ "format": "trace-graph",
  "payload": { "nodes": [{ "id": "REQ-11", "type": "requirement", "ref": "req://REQ-11" },
                          { "id": "CASE-3", "type": "case", "ref": "test://t-12" }],
               "edges": [{ "from": "REQ-11", "to": "CASE-3", "kind": "covered-by" }] } }
```
- `type ∈ requirement | plan | design | implementation | case | feedback`。
- **候选**：每条边，加每个节点缺失的一侧（无上游来源 / 无下游承接）；`locator = { fromId, toId? }`。**它验证的是其他所有领域的产出**。
- **闸门映射**：指向已删除对象 → `deleted`；不透明 ref → `binary`；超大图 → `bytes`。
- **fixtures**：`empty`、`all-gated-out`、`happy-path`、`dangling-ref`（指向已删除对象 → **失效链接必须报出**，不得静默跳过）。

### 5.2 fixture 文件形状（统一）

```json
{
  "name": "happy-path",
  "domain": "code-review",
  "format": "unified-diff",
  "input": { "format": "unified-diff", "payload": { "diff": "…" } },
  "expect": {
    "candidates": 4,
    "paths": ["src/a.ts", "src/b.ts"],
    "admitted": 3,
    "excludedByPredicate": { "default-path": 1 },
    "bounded": true,
    "truncated": false,
    "notes": [],
    "throws": null
  },
  "anchors": {
    "positive": [{ "claim": { "path": "src/a.ts", "locator": { "start": 2 } }, "excerpt": "const x = 1;", "expect": { "status": "anchored", "start": 2 } }],
    "negative": [{ "claim": { "path": "src/a.ts", "locator": { "start": 2 } }, "excerpt": "const x = 2;", "expect": { "status": "unanchored", "tier": "no-match" } }],
    "ambiguous": []
  }
}
```

- `expect.throws` 用来表达**必须失败**的输入（如 `malformed-diff.json` 应为 `E_INPUT_FORMAT`）。
- `domains/<id>/test.mjs` 必须断言 `validateFixture(fixture, format)` 为空——夹具本身也要被验证。

---

## 6. 完工标准 → 可执行检查清单

一个领域算完工，当且仅当 `validateDomainPackV2(pack)` 返回 `[]` **且** `domains/<id>/test.mjs` 全绿：

| # | 完工标准 | 机器检查 |
|---|---|---|
| 1 | `source.js` + fixture + 单测（含空集、全被闸门排除两个边界） | `validateCandidateSource`、`validateCandidateSetResult`、`fixture.expect` 覆盖 `empty`/`all-gated-out` |
| 2 | `anchor.js`，真实输入可重算，正例 + 负例（歧义必须拒绝） | `validateAnchorVerifier`、`validateAnchorVerdict`、`fixture.anchors.positive/negative` 非空 |
| 3 | `evidence.js`，有界，按需装载 | `validateEvidenceToolkit`、`normaliseEvidenceLimits` 硬上限夹紧 |
| 4 | `rules/*.md` ≥20 条，每条含 name/match/text，front-matter `needs-expert-review: true` | `validateRuleLibrary`、`validateRuleDocument` |
| 5 | `prompts.js`，P4 + P6 独立 | `validateReviewPrompts`、`validatePromptOutput`，且 P6 文本 ≠ P4 文本；**运行期**：P4 每捆一次、P6 在 `adjudication_submit` 对已锚定发现跑一次（`review.verify`），P6 上下文只含 `PROMPT_CONTEXT_FIELDS.verify` 且 `toolFilter.allow = []`（t41） |
| 6 | `index.js` v2，接上五个扩展点 | `validateDomainPackV2`（含 kind 自洽、`criticism.kind`、`bundleKey` 对象形态） |
| 7 | `test.mjs` 跑通 P0→P7，断言报告与覆盖率 | 必须遍历 `REQUIRED_TEST_STAGES`；P0 断言**跑两遍结果一致** |
| 8 | 被 `npm test` 纳入并通过 | `package.json` 的 `test` 脚本；`pack.testWired === true`（`requireTestWiring` 选项） |

**`npm test` 的目标形态**

```bash
node contract-test.mjs          # 34 条：契约自洽与校验器（t1 已存在）
node lib/kernel-test.mjs        # 49 条：契约 v2 运行时机制（t2 新增，t16 起含 skipped 形状锁）
node smoke-test.mjs             # 43 条：引擎与插件（必须保持 43 passed, 0 failed）
node mount-test.mjs             # 13 条：真实 Cordis（必须保持全过 / 或缺宿主时 SKIP）
node domains/run-all.mjs        # 19 个 domains/<id>/test.mjs 的总入口
```

`package.json` 的 `test` 脚本按上述顺序串联前四个；领域任务完成后把 `domains/run-all.mjs` 接到末尾。

---

## 7. PR 描述（接口签名汇总）

> 这一节就是为了直接粘进 PR 描述。

**标题**：`feat(contracts): domain contract v2 + five extension points`

**摘要**：为 19 个领域包定义 v2 契约（五个扩展点的确切 JS 接口、三个只声明字段的接入方案、P4 服务的选型与注入方式、领域目录的自动发现），并落地共享内核 `lib/contracts.js` 与 34 条契约自检。**不改动任何既有测试的通过状态**（`npm test`：43 + 13 全过）。

```js
// 1) candidateSource — P0
enumerate(input, context) => {
  candidates: Array<{ id, path, locator, text, key?, additions?, deletions?, bytes?, binary?, deleted?, title?, meta? }>,
  excluded: Array<{ id, reason }>, notes: string[], bounded: boolean, truncated: boolean
}
// 失败：E_INPUT_FORMAT（输入不合法）；空集是合法结果；超界必须 truncated:true

// 2) anchorVerifier — P5
verify(claim: { kind, path, locator, excerpt? }, subject: { path, content, document?, documents?, candidates?, index? }, context) => {
  status: 'anchored' | 'unanchored',
  tier: 'declared-locator'|'recomputed-unique'|'relocated-unique'|'locator-mismatch'
      |'relocation-ambiguous'|'no-match'|'empty-excerpt'|'kind-mismatch'|'no-documents',
  path: string|null, start: number|null, end: number|null, locator?: object,
  ambiguousIn?: string[], detail?: string
}
// anchored 要求：行号家族给整数 range；ID/图家族给非空 locator（见 §1.2「裁决形状」）
// claim.locator 由引擎**原样透传**（不重建、不注入）；subject.document 是完整文档对象
// 失败：E_ANCHOR_CONTRACT（claim 形状不合法）；歧义与矛盾一律 unanchored，绝不猜

// 3) evidenceTools — 有界、按需装载
{ tools: Array<{ name, description, parameters, output, limits: { maxLines, maxItems, maxBytes, maxCalls }, execute(args, ctx) }> }
// 结果：{ items, truncated, provenance }；失败：E_EVIDENCE_LIMIT / E_BUDGET_EXHAUSTED / E_ABORTED
// 硬上限：maxToolsPerDomain 8 / maxCallsPerRun 20 / hardMaxLines 2000 / hardMaxItems 1000 / hardMaxBytes 262144

// 4) reviewPrompts — P4 + P6
review(context) => { system: string, rules?: string, budget?: string }
verify(context) => { system: string, instructions: string }   // 与 review 文本不同，且看不到 P4 的推理
// 运行期（t41）：P4 由 lib/reasoner.js:renderReviewPrompt 渲染，每捆一次；
//               P6 由 renderVerifyPrompt 渲染，adjudication_submit 里对已锚定发现跑一次，
//               结果落在 submit 返回值的 review.verify（ran / prompt.source / toolFilter / verdicts）
// 失败：抛异常即回退到 v1 pack.prompt，流水线不因缺提示词而失败

// 5) ruleLibrary — P3
{ dir: 'rules', load: (io) => Rule[] } | { rules: Rule[] }
Rule = { name, match: string[], text, needsExpertReview: true, source }
// rules/*.md front-matter: name / match / needs-expert-review(true)
// 失败：<20 条 或 needs-expert-review !== true 或重名 一律 E_CONTRACT
```

**三个字段的接入**

| 字段 | 改造点 | 兼容策略 |
|---|---|---|
| `bundleKey` | `planFor()` 调 `resolveBundleKey(pack, entry, opts)` 后再 `bundle()`（`bundle()` 零改动） | v1 字符串**默认不生效**；v2 对象形态始终生效；`trustDeclaredStrategies` 一次性打开 |
| `candidateSet` | `adjudication_plan` 新增可选 `input` 入参 → `candidateSource.enumerate` | `candidates` 入参逐字保留；`candidateSet.kind`/`inputFormat` 与 source 强校验 |
| `criticism.kind` | `critique()` 读入并回显 `kind`；`report()` 增 `criticismKind` | kind **不进**保留/删除计算（那是 `lossOrientation` 的职责）；19 个 pack 已天然自洽 |

**P4 服务选型**：主 `ctx.subagents`（独立上下文 + `toolFilter` + `outputSchema` + `maxDepth` + `signal`），兜底 `ctx.llm.stream`（C 探索型的找候选一轮 / 无 subagents 时降级）。**可选注入**：`ctx.inject(['subagents'], …)` / `ctx.inject(['llm'], …)`，绝不进静态 `inject`。预算走 `charge()` 预扣，未启动的批次进报告；取消转发 `exec.signal` 与 `SubagentRun.result.stopReason`。

**领域组织**：`domains/<id>/{index,source,anchor,evidence,prompts}.js + rules/*.md + fixtures/*.json + test.mjs`，由 `lib/domain-loader.js` 自动发现装配；`lib/domains.js` 冻结为 v1 参照物，领域所有者不再触碰任何共享文件。

**新增文件**：`lib/contracts.js`、`contract-test.mjs`、`docs/domain-contract-v2.md`；`package.json` 增加 `./contracts` 导出与 `test:contracts` 脚本（只增）。

**诚实声明**：规则库由 agent 起草、标注 `needs-expert-review: true`，**未经领域专家审定**。这是能力边界，不是可以糊弄过去的东西。

---

## 8. 许可、出处与诚实边界

- 本契约与 `lib/contracts.js`、`contract-test.mjs` 为**原创**：未移植 open-code-review 的任何代码，因此 `NOTICE` 无需新增条目。
- 机制与常量移植自 Alibaba [open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0）的部分集中在 `lib/engine.js`，其函数注释与 `NOTICE` 已逐处标注对应源文件；移植部分均**经过改造**（代码评审专用逻辑抽象为领域无关原语）。一处**有意的偏离**：上游锚定第三级是 LLM 重定位，本插件不实现——模型猜出来的锚点不是引擎能验证的锚点。
- 本项目 **Apache-2.0**，见 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。任何新增的移植代码必须同步更新这两处标注。
- **诚实清单**（不得在任何交付物里被淡化）：
  1. 规则库是 agent 起草的**草稿**，标注 `needs-expert-review: true`，**未过专家审定**；
  2. 锚点没有 LLM 兜底层（有意为之），逐字抄写不精确的发现会降级为「未锚定」；
  3. C 探索型领域（`market-research` / `reverse-engineering`）**不承诺有界成本**；
  4. 真实系统对接不在本轮范围：本文给出的是输入格式与适配方式，不是已接通的集成。

---

## 9. F2 —— ID / 表 / 图层 / 流程家族的锚点在**插件路径**上够不够得着（t21 诊断）

### 9.1 问题

t11 审查报出：对 `ux-review` / `ui-visual` / `architecture` 自己的 fixture 正例调 `adjudication_anchor`，一律 `unanchored/no-documents`；带 locator + documents 提交同样 `reviewed = 0`。也就是说这些域的覆盖率里有一个**恒为 0** 的数，被 `reviewed <= 3` 掩盖了。

### 9.2 量法（先说清口径，否则数字没有意义）

探针必须走**真实路径**，否则量到的是别的东西：

1. `apply()` 挂真实插件 + `createNodeIo` 挂真实 `domains/`（**`createNodeIo` 是 async，必须 `await`** —— 漏掉它会静默走进 `ensureDirectoryDomains` 的 catch，注册表里只剩 19 个内置 v1 pack，于是量到的是「内置 pack + 引擎通用阶梯」）；
2. 每个域的 **happy-path fixture 正例**，逐条走**真实 `adjudication_anchor`**（不是直接调 `verify`）；
3. `documents` 参数 = fixture 自己的 `subject.documents`，再加一条「把 `subject.content` 折成与 `subject.path` 同名的文档」—— 这等于**调用方把被审文件交回来**，是生产路径上真实存在的动作。

三种喂法，分开报：

| 记号 | 喂了什么 |
|---|---|
| **M1** | fixture 自己声明的 documents（+ 上述 `content` 折叠） |
| **M2** | M1 + 一份**约定文档**，路径取自该域自己的常量（`lineage/[…].json`、`experiments/[…].json`、`research/[…].json`、`re/[…].json`），内容是 fixture 里那份结构导出的 JSON |
| **M3** | M1 + 先跑一次真实 `adjudication_plan(domain, input)` —— 于是引擎把 `subject.candidates` 交给了验证器 |

**M2 只在「该域自己定义了约定文档路径」时才有意义**：若一个域的 `anchor.js` 里根本没有 `JSON.parse`，它就**没有任何**文档路线，M2 记 `n/a`。这正是「域没做」与「探针没给它材料」的分界。

**用拒绝理由区分「locator 没到」与「subject 没到」**（t10 审查者独立复现时给出的判据，本喵复核成立）：`architecture` 的拒绝理由是 **`no-documents`**（「没有提供模块依赖图（modules）」），而**不是** `locator-mismatch`（「没有点名 moduleId」）—— 前者说明 **locator 已经原样到达**，缺的只是结构化 subject。这条判据比一个 `0/N` 信息量大得多，判 `(b)`/`(c)` 时应当先看它。

### 9.3 实测（19 个域，happy-path 正例，经真实 `adjudication_anchor`）

| 域 | M1 | M2 | M3 | 验证器读的键 | 判定 |
|---|---|---|---|---|---|
| code-review | 3/3 | n/a | 3/3 | `path, content, documents` | 无缺口 |
| backend-engineering | 3/3 | n/a | 3/3 | （复用 code-review 的验证器） | 无缺口 |
| frontend-engineering | 3/3 | n/a | 3/3 | （同上） | 无缺口 |
| user-feedback | 7/7 | n/a | 7/7 | `path` + 图文档 | 无缺口 |
| product-planning | 3/3 | n/a | 3/3 | `path, content, documents` | 无缺口 |
| requirement-research | 3/3 | n/a | 3/3 | `content, documents, times` | 无缺口 |
| tech-test | 2/2 | n/a | 2/2 | `content, coverage, documents` | 无缺口（`coverage` 可由文档正文回退） |
| project-management | 2/2 | 2/2 | 2/2 | `payloadOf` 自折叠 | 无缺口（**现成范例**） |
| requirement-alignment | 4/4 | n/a | 4/4 | 图文档 | 无缺口（早期 0/4 是**装载失败**，见 9.5） |
| risk-compliance | 3/3 | n/a | 3/3 | `clauses` / **`candidates`** | 引擎侧已兑现（见 9.4） |
| data-engineering | 2/7 | **7/7** | 2/7 | `lineage` / 约定文档 | **(c) 调用方须交约定文档** |
| algo-model | 1/5 | **5/5** | 1/5 | `experiments` / 约定文档 | **(c)** |
| market-research | 1/6 | **6/6** | 1/6 | 任意 JSON 登记表 | **(c)** |
| reverse-engineering | 1/6 | **6/6** | 1/6 | 任意 JSON 登记表 | **(c)** |
| tech-doc | 1/2 | n/a | 1/2 | `api, sections` 直接字段 | **(b) 先定约定** |
| architecture | 0/4 | n/a | 0/4 | `modules, layers, adrs` 直接字段 | **(b)** |
| operator-design | 0/2 | n/a | 0/2 | `operators, tests` 直接字段 | **(b)** |
| ui-visual | 0/3 | n/a | 0/3 | `layers, tokens` 直接字段 | **(b)** |
| ux-review | 0/3 | n/a | 0/3 | `flow, steps, branches` 直接字段 | **(b)** |

### 9.4 引擎侧：**改**，因为契约承诺了而引擎没兑现

**结论：`subject.candidates` 是「该兑现而不兑现」，不是「文档写错了」。** 判据三条：

1. **契约原文承诺了它**：§1.2 的 `subject` 签名里写着 `@param {object[]} [subject.candidates]  P0 产出，locator 空间在这里`，并把它列为「引擎侧材料」。删掉它等于把 `risk-compliance` 这类「结构侧就是候选集」的域的**唯一**可信来源删掉；
2. **引擎手上本来就有它**：`adjudication_plan` 里 `capped` 就是闸门准入后的候选集，引擎只是没记住；
3. **交出去不需要认识任何领域形状**：那些条目是**领域自己的对象**（`source.js` 从调用方 payload 枚举出来的），引擎把整个数组当不透明值透传。这正是「把调用方的材料递到位」与「凭引擎想象构造领域数据」的分界。

**已实现（`CHANGED (t21)`）**：
- `index.js` 新增 `planCandidates`（domain id → 该域 plan 准入后的候选集，浅拷贝）；
- `recomputeAnchor(pack, finding, documents, candidates)` 把 `candidates` 放进 subject —— **未知时整个键缺席**，不是空数组（「没提供候选集」与「提供了空候选集」是两件事，`risk-compliance` 的 `toBindings` 就用它区分）；
- `adjudication_anchor` 新增可选入参 `candidates`，没给就用该域上次 plan 的那份；`adjudication_submit` 用 plan 的那份。

**修复真的改变了行为（实测，`risk-compliance`）**：

| 提交的绑定 | 修复前 | 修复后 |
|---|---|---|
| `(DP-01, svc-profile-read)`（候选集里真有） | `anchored` | `anchored` |
| `(DP-01, not-a-real-surface)`（候选集里没有） | **`anchored`** | **`unanchored` / `no-match`** |

即：该域写在 `anchor.js` 里的「这条条款管不着这个面，拒绝凭空建立绑定」在生产路径上**以前根本执行不到**。这是 F3 同一族的第三个实例：**领域规则写对了，引擎没把材料递到位**。

**明确不改的**：引擎**不**把 `subject.document` 的字段展开进 `subject`。理由见 §1.2 —— 展开要引擎决定「哪个文档、哪些键、撞名怎么办」，那是替领域做形状决策；而且实测证明它**解决不了**问题：`(b)` 类域要的结构（`ux-review` 的 `flow`/`branches`、`ui-visual` 的 `layers`/`tokens`）**根本不在任何文档里** —— fixture 里没有，而且**即使把一份 JSON 文档塞进 `documents`，这些域的 `anchor.js` 也不会去读它**（无 `JSON.parse`、不读 `subject.document`，M2 记 `n/a`）。它是 P0 的 `input.payload`，由 `source.js` 消费掉、以**候选集**的形式留下来。所以正解是 `subject.candidates` + 领域侧读它，不是展开文档。

### 9.5 领域侧：逐域要改什么（**本任务不动别人的领域目录**）

**先给归类，再给修法。** 对「插件路径上够不着」的每一个域，四选一（依据一律是**实测**，不是推测）：

| 归类 | 含义 | 判据（怎么测出来的） | 本批域 |
|---|---|---|---|
| **(a) 领域侧补回退** | 材料**已经在文档里**，域只是没去读 | fixture 的 documents 里已有该结构，或 M2 有效而域仍未读 —— 实测**没有任何一个域落在这一类** | **（空）** |
| **(b) 先定约定** | 域**没有任何文档路线**：`anchor.js` 里既无 `JSON.parse`，也不读 `subject.document` | 给一份带结构的文档也无事发生（M2 = n/a，因为连约定路径都不存在） | `architecture`、`operator-design`、`ui-visual`、`ux-review`、`tech-doc`（`signature` 那一半） |
| **(c) 引擎侧** | 契约承诺了、引擎没递；或递送方式错误 | 契约原文 + 修复前后的行为差 | `risk-compliance`（`subject.candidates`，**已修**，见 9.4） |
| **(d) 调用方 / fixture 侧** | 路线**已经通了**，缺的是有人把约定文档交上来 | M2 让该域从 1–2/N 直接到 N/N，**代码一行没改** | `data-engineering`、`algo-model`、`market-research`、`reverse-engineering` |
| — | 无缺口（早期 0/N 是**装载失败**或探针没折 content） | M1 或 M3 即为 N/N | `requirement-alignment`（装载失败，已由 domain-bc 修复）、其余 8 个 |

> **(c) 里明确排除「引擎把 `document` 展开进 `subject`」这一种做法** —— 它是被考虑过、并用实测否掉的，理由见 §1.2 与 9.4 结尾：那 4 个 `(b)` 域要的结构**根本不在任何文档里**（它们是 P0 的 `input.payload`，被 `source.js` 消费后以**候选集**的形式留下来），所以展开文档对它们**一例都救不了**。

**(b) 类 —— 先定「自折叠约定」，再补回退。** 这 4 个域（外加 `tech-doc` 的 `signature` 那一半）的结构侧**只读直接字段**，且 `anchor.js` 里没有 `JSON.parse`，也就是**没有任何文档路线**；它们的 P0 候选集里恰好带着所需的结构事实（实测）：

| 域 | 验证器现在只读 | 候选集 locator 里已经有的 | 建议改法 |
|---|---|---|---|
| `ux-review` | `subject.flow` / `steps` / `branches` / `branch` | `{branchId, stepId, nodeId}` | 增 `structureOf(subject)`：先读 `subject.branches`/`flow`（库调用者），再 **从 `subject.candidates` 重建** (branch, step) 成员关系；文档正文那条路留给证据侧 |
| `ui-visual` | `subject.layers` / `tokens` | `{layerId, prop, tokenName}` | 同上，从候选集重建 layer/prop/token 三元组 |
| `architecture` | `subject.modules` / `layers` / `adrs` | `{moduleId, targetId, adrId, status, findingKind}` | 同上，从候选集重建边与 ADR 事实 |
| `operator-design` | `subject.operators` / `tests` | `{operator, backend, dtype, shapeBranch, signature}` | 同上 |

> 这四条的**共同前提**是：它们的结构事实**已经由本域自己的 `source.js` 从调用方 payload 枚举出来了**。所以「从候选集重建」不是让验证器相信调用方，而是让验证器**回到 P0 的那份枚举**去核对发现 —— 与 `code-review` 从文档正文重算行号是同一件事。

**(d) 类 —— 路线已经通了，缺的是「谁交那份文档」。** `data-engineering` / `algo-model` / `market-research` / `reverse-engineering` 的约定文档回退**已经实现且实测有效**（M1 → M2：`data-engineering` 2/7 → **7/7**、`algo-model` 1/5 → **5/5**、`market-research` 1/6 → **6/6**、`reverse-engineering` 1/6 → **6/6**；同一份代码、同一个引擎，只多了一份约定文档）：

| 域 | 约定文档路径（取自本域常量） | 文档内容 |
|---|---|---|
| `data-engineering` | `/^lineage\/[a-z0-9._-]*\.json$/` | `{ nodes, schema? }` |
| `algo-model` | `/^experiments\/[a-z0-9._-]*\.json$/` | `{ experiments }` |
| `market-research` | 任意文档，JSON 且含 `sources` | `{ question, sources, claims }` |
| `reverse-engineering` | 任意文档，JSON 且含 `artifact`/`observations` | `{ artifact, observations }` |

它们需要的是 **fixture 自带自折叠 subject**（把结构导出放进一个约定路径的文档），这样域自己的 `test.mjs` 才能断言「经真实插件工具锚得住」。这是 domain-bc 在 t19 提出的那条要求，本喵复核**成立**。

**(a) 类 —— 没有 (a)：探针能提供的材料都已提供，仍锚不住的都是 (b)。** 唯一曾落在两类之间的是 `tech-doc`（1/2）：过的那条只靠文档正文，没过的那条论断 `apiName` 与文档一致，需要 API surface（`subject.api`），而它的 `anchor.js` 没有文档回退 —— 归入 (b)。

### 9.6 装载失败：一个**看起来和「没迁移」一模一样**的静默降级

`domains/requirement-alignment/` 一度**装载失败**（`source.js` 被 import 了 `derivedPath` 却没有转发它，而 `anchor.js` 又从这个 `source.js` 取 `derivedPath`）→ `loadDomains` 记 `module load failed`、跳过该包 → 插件退到 `via: 'engine-resolveAnchor'`。

**这个失败形态没有边界报错**：工具照常返回，`via` 只是「引擎通用阶梯」，与「这个域还没迁移」**逐字无法区分**。domain-bc 已修好该域（本喵复测：19 个包全部装载成功，`requirement-alignment` 4/4）。

为了让这一类**不再可能静默**，本仓新增 `lib/imports-check.mjs`（已纳入 `npm test`，也有 `npm run test:imports`）：扫全部 `.js`/`.mjs`，把每一条**具名相对 import / re-export** 的目标模块真的 `import()` 进来核对导出名是否存在。当前实测：**128 个模块 / 872 条具名绑定全部可解析**。它抓不到的问题（默认导入、命名空间导入、动态 `import()`、包名）都不属于这个失败形态 —— 列在这里是为了说明它不是「什么都检查」。

### 9.7 比 F2 本身更严重的一件事：**19 个域自测全绿，其中 4 个在真实插件路径上一例都锚不住、1 个只锚得住一半**

（4 个 = `architecture` / `operator-design` / `ui-visual` / `ux-review`；「一半」= `tech-doc` 2 条正例里过 1 条。另有 4 个 `(d)` 类域：路线已通，但域自己的测试从未把约定文档交上去，所以也从没在生产形状下被验证过。）

根因是**全队共有的盲区**，不是某个域的错：每个域的 `test.mjs` 都是直接调 `anchor.verify(claim, <自己造的 subject>)`，**从未经过引擎**。于是测试测的是「验证器在理想输入下对不对」，而不是「它在生产路径上能不能被喂到」。`domains/<id>/test.mjs` 里 P0→P7 的往返也常常手工喂候选、手工喂 subject。

**因此对全部 19 个域的通用要求（本喵复核后确认必要）**：每个域至少要有一条断言，证明**它自己的锚点能经真实 `adjudication_anchor` / `adjudication_submit` 拿到 `anchored` 且被计入 coverage**，而不仅是直接调 `verify`。`via === 'anchorVerifier'` 必须被断言 —— 它是「领域验证器真的跑了」与「引擎偷偷兜底了」之间**唯一**的机器可判别标志。

### 9.8 复现方法

探针在 `$TEMP/t21probe/`（不进仓库）：`probe-plugin.mjs`（M1 逐域表）、`probe-convention.mjs`（M1/M2）、`probe-final.mjs`（M1/M2/M3 合并表）、`probe-detail.mjs`（失败项逐条的 locator、fixture 结构键、验证器原话）、`probe-risk.mjs`（9.4 那张表）。全部只读仓库、只写 `$TEMP`。
