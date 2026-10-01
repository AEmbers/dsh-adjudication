# code-review — 参照域的端到端实现

> 本文说明 `dsh-adjudication/domains/code-review/` 里**实际有什么**、怎么跑、
> 哪些是已验证的、哪些是能力边界。上游对照的细节在
> [`../../domains/code-review/COMPARISON.md`](../../domains/code-review/COMPARISON.md)。
>
> **诚实前提（请勿在别处省略）**：`rules/*.md` 是 **31 条 agent 起草的规则草稿**，
> 每条 front-matter 标注 `needs-expert-review: true`，`RULE_PROVENANCE.expertValidated`
> 保持 `false`。**未经领域专家审定。** 这是一份「引擎完整、规则库是草稿」的领域，
> 不是一个已审定的评审标准。

## 0. 一句话状态

`code-review` 是第一个从「只有声明」走到「端到端可运行」的领域：它有候选集枚举器、
行级锚点验证器、三个有界取证工具、31 条规则、两个互相独立的提示词角色、四个 fixture，
以及一份 `P0 → P7` 全链路断言（**79 passed, 0 failed**）。

`domains/code-review/` 一旦存在，插件默认的惰性目录发现就会扫到它，并用这份 v2 包
**替换** `lib/domains.js` 里同 id 的 v1 包——这就是迁移路径，`lib/domains.js` 一字未改。

## 1. 八个交付物

| 文件 | 对应契约 | 说明 |
|---|---|---|
| `index.js` | 领域包 v2 | 声明 `candidateSet` / `gate` / `bundleKey` / `anchor` / `criticism` / `prompt`。**不内联**任何扩展点——五个扩展点由 loader 从兄弟文件装配（`test.mjs` 断言了这一点） |
| `source.js` | §1.1 candidateSource (P0) | `unified-diff` → 每个 **(文件, hunk)** 一个候选；二进制/删除/重命名各成一个候选 |
| `anchor.js` | §1.2 anchorVerifier (P5) | diff 行滑窗；**行号一律重算**，矛盾或不唯一时判未锚定 |
| `evidence.js` | §1.3 evidenceTools (P7) | 三个有界工具，按需装载，上限由 `limits` 声明并被契约钳制 |
| `prompts.js` | §1.4 reviewPrompts (P4/P6) | `review()` 与 `verify()` 是**两份不同的文本** |
| `rules/*.md` | §1.5 ruleLibrary (P3) | 31 条，每条 front-matter 有 `name` / `match` / `needs-expert-review: true` |
| `fixtures/*.json` | §4 | `empty` / `all-gated-out` / `happy-path` + `small-change`，各带正例与负例锚点 |
| `test.mjs` | §4 | P0→P7 全链路；**79 条断言** |

## 2. 怎么跑

```bash
# 领域自测（本文描述的 79 条断言）
node dsh-adjudication/domains/code-review/test.mjs

# 全部领域自测（自动发现 domains/<id>/test.mjs，无需改任何共享文件）
npm --prefix dsh-adjudication run test:domains

# 契约与内核回归
npm --prefix dsh-adjudication run test:contracts
npm --prefix dsh-adjudication run test:kernel

# 全部
npm --prefix dsh-adjudication test
```

### 「同一份断言，不同的被测对象」——迁移领域时最容易踩的坑

`apply(ctx, {})` 会读**真实**的 `domains/` 目录。所以一个想断言「内置库如何」的测试
一旦不传 `domainIo`，只要目录里出现了 v2 领域包，它就会**不知不觉地改成测那个领域**：
`adjudication_activate` 会多返回领域自带的取证工具，领域规则库会顶掉 pack 的内联规则。
断言没变，被测对象变了。

本仓库的统一做法：**这类测试一律传 `EMPTY_DOMAIN_IO`（`{ domainIo: createMemoryIo({}) }`）**，
想测发现机制的测试则传**有内容**的内存 io。`lib/kernel-test.mjs`、`smoke-test.mjs` 顶部
都有同一条规则说明，`domains-test.mjs` 负责把 `domains/<id>/test.mjs` 纳入 `npm test`——
**新增一个领域不需要改任何共享文件**，这是刻意的。

## 3. 输入格式（文档化）

```jsonc
{
  "format": "unified-diff",
  "payload": {
    "diff": "git diff --unified=3 --no-color 的输出",
    "files": [                                   // 可选，来自 --numstat / --name-status
      { "path": "src/app.ts", "bytes": 320, "additions": 2, "deletions": 1, "status": "modified" }
    ]
  }
}
```

通过工具喂进去：

```jsonc
// adjudication_plan / adjudicate_code_review
{ "domain": "code-review", "target": "PR #1", "input": { "format": "unified-diff", "payload": { … } } }
```

`candidates` 入参仍然可用（逐字保留 v1 行为）；`input` 与 `candidates` 二选一。
`input.format` 与领域声明不符时**直接拒绝**，不做强制转换。

### 候选集形状

每个候选是 `{ id, path, locator, text, bytes, additions, deletions, meta }`，其中：

- `path` **始终是文件路径**，绝不是 `file#hunk-1` 这种合成 id。原因是 P1 闸门拿 `path`
  去匹配扩展名 glob，带 `#` 的 id 会被 `extension` 谓词整个打掉——一个安静的、看起来
  像「没有候选」的灾难。hunk 的区分放在 `id` 与 `locator.hunkIndex` 里。
- `locator = { kind:'diff-line', hunkIndex, startLine, endLine, side }`，行号是**新文件**
  的 1-based 行号（删除文件是旧文件）。
- `bytes` 是**这段 hunk 摘录**的字节数，不是整个文件的大小。契约
  `GATE_FIELD_MAPPING.bytes` 定义的是「这个候选会放进上下文的材料的字节数」，
  而这里的候选是 hunk；用整文件大小会让一个大文件把它所有的 hunk 一起否决掉。

## 4. 锚点（硬约束）

模型**不输出行号**，只逐字抄写原文；引擎用滑窗重新定位。判定阶梯：

| tier | 含义 | 是否可信 |
|---|---|---|
| `declared-locator` | 模型声明的行号处**确实**是这段原文 | ✅ |
| `recomputed-unique` | 没给行号，原文在该文件内**唯一**命中 | ✅ |
| `relocated-unique` | 声明的文件不在文档集里，原文在**恰好一个**别的文件里 | ✅ |
| `locator-mismatch` | 声明了行号，但那里的原文对不上 | ❌ 终态 |
| `relocation-ambiguous` | 两处或更多同样合法 | ❌ 终态，`ambiguousIn` 列出竞争者 |
| `no-match` / `empty-excerpt` / `kind-mismatch` / `no-documents` | 其余终态 | ❌ |

**匹配是逐字的。** 只忽略缩进与 diff 标记（`+`/`-`/空白），**标点与标识符一律不放过**：
`sum` 写成 `add`、`30_000` 写成 `30000`、少一个分号，都是**不同的行**，判未锚定。
这条不许放宽换取通过率——一个靠模糊匹配撑起来的锚点率是假的。

`fixtures/*.json` 里每个 fixture 都带 `anchors.positive` 与 `anchors.negative`；
`happy-path` 另带 `anchors.ambiguous`。`test.mjs` 逐条断言 `status` **和** `tier`——
只断言 `status === 'anchored'` 会被一个「猜对了」的验证器满足。

## 5. 取证工具（P7，有界）

三个工具都由调用方注入 `documents: [{ path, content }]`，**自己不读文件系统**
（本包零运行时依赖，任何 `node:fs` 都会破坏这一点）。

| 工具 | 上限 | 说明 |
|---|---|---|
| `read_lines` | ≤120 行 / 8 次 | 读某个文件的指定行区间 |
| `search_diff` | ≤100 条 / 10 次 | 在变更文件里检索字面文字 |
| `enclosing` | ≤16 行 / 6 次 | 按缩进向上回溯找出包含目标行的语句块（**启发式**，返回值里说明回溯了多少行） |

返回一律 `{ items, truncated, provenance, notes }`。被截断就 `truncated: true` 并在
`notes` 里说明，**不静默少给**。工具名由 `evidenceToolName('code-review', …)` 派生，
注册名是 `adjudicate_code_review_evidence_<name>`，只在领域被 activate 之后存在。

## 6. 提示词：P4 与 P6 必须是两份

- `review(context)` → P4，拿到规则、路径、预算，负责判断。
- `verify(context)` → P6，**只拿到发现本身**，看不到 P4 的推理过程、规则与工作单。
  这是刻意的：看得到推理就会去评价推理，看不到才只能核对事实。P6 有「反方义务」——
  先写出最强反驳，再给结论。

**契约校验器不检查两者是否相同**（`validateReviewPrompts` / `validateDomainPackV2`
对同文本一律返回 `[]`）。所以 `test.mjs` 自己断言：

```js
assert.notEqual(P6.system, P4.system)
```

少了这一条，一个领域可以顺利过闸门却交出一个「自己复核自己」的 P6，等于 P6 层不存在。
后续 18 个领域的 `test.mjs` 请照抄这条断言。

## 7. 上游对照：做到哪一步

`COMPARISON.md` 是**静态对照**——逐条读 open-code-review 的源码常量与谓词顺序。
**上游 Go 二进制没有构建**（本机无 `go`），所以没有任何运行期对照数据。已核实的差异：

| 维度 | 结论 |
|---|---|
| 默认排除模式 | 20 条**逐条一致** |
| 闸门谓词顺序 | 语义一致；`deleted` 位置不同（上游在静态闸门之后，本插件在 `secret` 之后），只影响报告的原因文本，不影响准入结果 |
| 支持的扩展名 | 上游 **116** 个，本插件 **26** 个 → 本插件准入集合是上游的**子集** |
| 凭据路径 | 上游 **10** 条（不含 `.env`），本插件 **17** 条（含 `.env`、`*.pem`、`*.key`…）→ 同一份 diff，`config/.env` 上游放行、本插件拦下 |
| 分捆 | 上游超过阈值时**交给 LLM**；本插件按确定性 `bundleKey` 分组 |
| 锚点 | 上游第四级是 LLM 重定位，本插件**刻意不做**，并把「矛盾」与「歧义」拆成两个可辨认终态 |

要补运行期对照，需要一台能 `make build` 的机器；`COMPARISON.md` 末尾写了具体命令与
预期会出现的三处差异，供对照时核对。

## 8. 已知限制（诚实清单）

1. **规则库未经专家审定。** 31 条 agent 草稿，全部标 `needs-expert-review: true`。
   它们的价值是「把判定依据显式写下来、可被逐条质疑」，不是「这是对的」。
   规则文本里的「不算：…」段落是刻意加的——它阻止一条规则变成「什么都能提」的许可证。
2. **上游对照是静态的，未构建二进制。** 没有同一份 fixture 的运行期逐文件对照表。
3. **`enclosing` 是启发式。** 按缩进回溯，不是语法解析；对非缩进语言（或压缩代码）
   会给出一段没什么用的上下文。返回值里标了「启发式」。
4. **`bytes` 不驱动 `too-large` 的常规路径。** 它是 hunk 摘录的字节数；要在真实运行里
   触发 `too-large`，需要调用方给的 hunk 超过 `maxFileBytes`（默认 1 MiB）。
   `test.mjs` 用 `gate(..., { maxFileBytes: 1024 })` 显式压阈值来测这条谓词，
   而不是造一个巨大的 fixture。
5. **P4 的 `ctx.llm` 兜底路径未在真实 provider 上跑过。** 本领域的 P4 走
   `ctx.subagents` 主路径（`test.mjs` 用 fake service 断言了它；t3 已把
   `lib/reasoner.js` 的字段与真实 `@deepseek-ai/dsh-subagent` 声明逐字段比对）。
   仅有 `ctx.llm` 的宿主机走降级路径，**该路径未验证**。
6. **`domains/code-review/` 的存在曾改变 7 条既有内核/挂载断言。** 那是因为 t2 前后的
   断言里写着「本包没有 domains/ 目录」「activate 只注册 3 个工具」——这份领域让它们不再
   成立。改动清单：`lib/kernel-test.mjs`（13 处 `apply` 改用空内存 io、3 条断言改用
   v1 领域的对应主体、新增 3 条更严的断言）、`mount-test.mjs`（改为断言 6 个**具体工具名**
   而不是数量）、`smoke-test.mjs`（12 处 `apply` 改用空内存 io）、`package.json`
   （新增 `test:domains` 与 `domains-test.mjs`）。**每条被改的断言都在原地写了注释**，
   说明「为何这样改、原断言假设了什么」——没有任何一条被删除或放宽，
   内核断言数从 48 升到 51，挂载断言仍是 13 条。

## 9. 给后续 18 个领域的清单

照抄这套结构即可，但有五件事值得单独说：

1. `id` 必须等于目录名（loader 直接拒绝不一致，否则会造出幽灵工具名）。
2. `index.js` 里**不要**内联扩展点——让 loader 从兄弟文件装配，`test.mjs` 断言它装配成功。
3. `candidate.path` 必须能被闸门 glob 到。合成 id 只能进 `id`/`locator`，不能进 `path`。
4. 每个 fixture 都要有 `anchors.positive` **和** `anchors.negative`；负例至少要覆盖
   「转述不锚定」与「歧义时拒绝猜测」这两类。
5. `test.mjs` 必须自己断言 `P6.system !== P4.system`。契约不查这一条，只有你查。
