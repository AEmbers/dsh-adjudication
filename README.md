# dsh-adjudication

**一个面向 DeepSeek Harness 的多领域审定引擎 bundle 插件。**

它不是十九个 Agent，也不是十九份 prompt，而是：

- **一个领域无关的确定性引擎** —— 枚举、闸门、分捆、规则注入、锚点解析、损失取向、覆盖度记账；
- **十九个领域包（domain pack）** —— 纯数据，回答「候选集是什么、哪些谓词该拒绝、锚点长什么样、该往哪边损失」；
- **一套按需装载的工具面** —— 常驻 6 个工具，十九个领域 × 3 个工具**默认全部不注册**，用到哪个装哪个。

设计承接自阿里开源 [open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0）的机制解构：把「让模型更聪明」换成「让模型少做决定，且每个决定系统能独立复核」。引擎负责所有可确定性重算的部分，模型只负责在有界范围内做判断，且它给出的每一条结论都必须能落回一个引擎能重新验证的锚点。

---

## 文档

| 文档 | 讲什么 |
|---|---|
| [`docs/domain-contract-v2.md`](docs/domain-contract-v2.md) | **规范**：五个扩展点的确切接口、三个只声明字段的接入、P4/P6 运行期语义、十九个领域的输入格式清单 |
| [`docs/domain-contract-v2-runtime.md`](docs/domain-contract-v2-runtime.md) | **运行时**：目录发现与装配、配置项、P4 执行器的预算/取消/降级、工作树与干净检出的验证口径 |
| [`docs/adding-a-domain.md`](docs/adding-a-domain.md) | **动手写第 20 个领域**：八件套配方、每一步的真实命令、踩过的坑与自校验命令 |
| [`docs/review-antipatterns.md`](docs/review-antipatterns.md) | **审查方法论**：15 种「让断言看起来在守、实际上没守」的缺陷形态（写领域断言前先读） |
| [`domains/code-review/COMPARISON.md`](domains/code-review/COMPARISON.md) | 参照域与上游 open-code-review 的静态对照（本机无 Go，未构建上游二进制） |

---

## 为什么是「按需装载」

工具 schema **每一轮都要重新计费**。open-code-review 的经验值是每文件平均 7 轮主循环；如果一个插件一次性声明全部工具（19 个领域全激活时实测是 **145 个**：6 个核心 + 139 个领域工具），每轮都要为它们付钱，而其中绝大多数在本次会话里根本不会被调用。

所以本插件把工具面拆成两层：

| 层 | 工具 | 何时注册 |
|---|---|---|
| **常驻** | `adjudication_domains` / `_activate` / `_deactivate` / `_plan` / `_anchor` / `_submit` | 插件挂载时 |
| **按需** | `adjudicate_<领域>` / `adjudicate_<领域>_plan` / `adjudicate_<领域>_rules` | 模型调用 `adjudication_activate` 时 |

模型先查领域、再装领域、用完卸载。**在一个领域都没激活的会话里，这个插件只占 6 个工具的 schema。** 下游再加二十个领域包，常驻成本一点都不涨。

---

## 安装

三种方式，任选其一。

### 1. 从本地路径装（开发用）

```bash
dsh plugin --profile <profile> add /绝对/路径/dsh-adjudication
```

> ⚠️ `desktop` profile 被 CLI 拒绝（`rejectElectronProfile`），桌面版请在 Web GUI 的「插件」页里装，或改用其它 profile 名。

装完包会被追加进 profile 的 `dsh.profile.bundles`，`cordis.patch.yml` 插入的 row 随即生效。

### 2. 从 tarball 装

```bash
pnpm pack            # 产出 dsh-adjudication-0.1.0.tgz
dsh plugin --profile <profile> add ./dsh-adjudication-0.1.0.tgz
```

### 3. 不安装，直接 overlay（最快验证）

写一个 overlay 文件，`insert` 行的 `name` 用相对路径（会被 Loader 转成相对该 patch 文件的 `file://` URL）：

```yaml
# scratch.cordis.patch.yml
- insert:
    - id: adjudication
      name: './dsh-adjudication/index.js'
      config:
        domains: ['code-review', 'ux-review']
```

```bash
dsh web --patch ./scratch.cordis.patch.yml
```

---

## 工具参考

### 常驻工具

| 工具 | 阶段 | 作用 |
|---|---|---|
| `adjudication_domains` | — | 列出/检索领域包，按 A/B/C/D 家族分组。**先查再选**，不要凭印象假设某个领域存在 |
| `adjudication_activate` | — | 按需装载某领域的专属工具。`depth=entry` 只装入口，`depth=full` 装入口+plan+rules |
| `adjudication_deactivate` | — | 卸载领域，注销其全部工具。用完就该卸载 |
| `adjudication_plan` | P0–P3 | 确定性产出有界工作单：闸门准入/排除明细、分捆结果、逐捆注入的规则、预算边界 |
| `adjudication_anchor` | P5 | 把模型抄写的原文定位到具体文档与行号 |
| `adjudication_submit` | P6–P7 | 交回判定：引擎重算锚点 → **P6 独立复核**（渲染并执行本领域的 `reviewPrompts.verify`，结果在 `review.verify`）→ 按损失取向取舍 → 出覆盖度证明 |

### 领域工具（激活后才存在）

以 `code-review` 为例，激活后得到：

- `adjudicate_code_review` —— 领域入口：出工作单 + 返回本领域的角色与损失取向
- `adjudicate_code_review_plan` —— 只跑 P0–P3
- `adjudicate_code_review_rules` —— 列出本领域规则库与锚点定义

---

## 十九个领域包

**十九个领域全部八件齐备，并且真的在跑**（下表每个数字都是实测，命令见本节末）。

合计：**460 条规则**（每域 20–32 条，**全部**标 `needs-expert-review: true`）、**63 个取证工具**、
**87 份 fixture**、**1822 条领域断言**。十九个域的 P0 枚举器都已实现——`plan` 的候选集
`candidateSet.origin` 十九个域全是 `candidateSource`（领域自己的枚举器产出），没有一个是调用方手工喂的。

> ⚠️ **规则库是 agent 起草的草稿。** 460 条规则全部由 agent 编写、全部带
> `needs-expert-review: true`（`rulesStatus: 'draft-v2'`），**未经任何领域专家审定**。
> 引擎、闸门、锚点、分捆、损失取向、覆盖率对每个领域都是完整且被断言的；**书面规则本身的领域正确性不在断言能覆盖的范围内**，那是需要领域专家投入的部分。任何交付物都不得声称这批规则已经过专家验证。

| 家族 | 数量 | 特征 |
|---|---|---|
| **A 审定型** | 10 | 候选集可确定性枚举，open-code-review 的形态可直接套用 |
| **B 构建型** | 4 | 审定型回路前面加一个受约束的生成器 |
| **C 探索型** | 2 | **P0 枚举失效**，候选集本身要找 —— 不承诺有界成本 |
| **D 关系型** | 3 | 产物是一致性本身，跑在锚点链建出的图上 |

逐域完工状态（家族 / 损失取向 / 锚点 kind / 规则数 / 取证工具数 / fixture 数 / `test.mjs` 断言数 /
**实测 plan：候选→准入 / 捆数**）：

| id | 标题 | 家族 | 损失取向 | 锚点 | 规则 | 取证 | fixture | 断言 | 实测 plan |
|---|---|---|---|---|---|---|---|---|---|
| `code-review` | 代码评审 | A | precision-first | diff 行滑窗 | 31 | 3 | 4 | 82 | 5→5 / 2 |
| `risk-compliance` | 风控合规监察 | A | **recall-first** | 条款 ID + 证据原文 | 26 | 3 | 4 | 93 | 22→22 / 5 |
| `ux-review` | UX 交互设计 | A | precision-first | 流程步骤 + 设计稿节点 | 22 | 3 | 4 | 86 | 8→8 / 3 |
| `ui-visual` | UI 视觉设计 | A | precision-first | 图层 ID + token 名 | 23 | 3 | 4 | 97 | 8→8 / 3 |
| `architecture` | 架构设计 | A | precision-first | 模块 ID + ADR 编号 | 32 | 3 | 4 | 106 | 8→8 / 3 ⚠ |
| `data-engineering` | 数据工程 | A | **recall-first** | 表.字段 + 血缘节点 | 24 | 3 | 5 | 99 | 16→16 / 3 ⚠ |
| `algo-model` | 算法模型 | A | **recall-first** | 指标名 + 实验 ID | 23 | 3 | 4 | 91 | 5→5 / 3 |
| `tech-test` | 技术测试 | A | **recall-first** | 用例 ID + 覆盖行 | 25 | 3 | 4 | 89 | 8→8 / 3 |
| `tech-doc` | 技术文档 | A | precision-first | 段落锚 + API 签名 | 25 | 3 | 4 | 86 | 6→6 / 2 ⚠ |
| `operator-design` | 算子设计 | A | **recall-first** | 算子签名 + 数值容差 | 26 | 3 | 4 | 89 | 5→5 / 2 |
| `requirement-research` | 需求调研分析 | B | **recall-first** | 原话逐字 + 时间戳 | 22 | 2 | 4 | 77 | 5→5 / 2 |
| `product-planning` | 产品规划经理 | B | precision-first | 需求 ID + 目标指标 | 22 | 2 | 4 | 75 | 4→4 / 3 |
| `backend-engineering` | 后端工程 | B | precision-first | diff 行滑窗 | 22 | 4 | 4 | 73 | 4→4 / 3 |
| `frontend-engineering` | 前端工程 | B | precision-first | diff 行滑窗 | 22 | 4 | 4 | 73 | 4→4 / 2 |
| `market-research` | 市场调研 | C | **recall-first** | 来源 URL + 原文引用 | 21 | 3 | 4 | 102 | 9→9 / 3 |
| `reverse-engineering` | 逆向工程 | C | **recall-first** | 可复现的观察 | 20 | 3 | 4 | 105 | 14→14 / 2 |
| `project-management` | 项目管理 | D | precision-first | 任务 ID + 依赖边 | 26 | 5 | 7 | 117 | 14→14 / 3 |
| `user-feedback` | 用户对接反馈 | D | **recall-first** | 反馈 ID + 原话 | 25 | 6 | 6 | 143 | 20→20 / 4 |
| `requirement-alignment` | 需求/潜在需求对齐 | D | **recall-first** | 可追溯 ID 链 | 23 | 4 | 9 | 139 | 28→28 / 10 |

**⚠ 两处「无独立证据」（据实标出，不外推）**：`architecture` 与 `tech-doc` 的「歧义必须拒绝」负例
——域内断言存在，但独立验证没能从 fixture 里触发到；`data-engineering` 的 `lineage_walk`（声明上限 40）
与 `column_contract`（60）两个截断格——没构造出足够输入。两处都只是**没有独立证据**，不是已知缺陷。

**这些数字怎么来的**（可复现；`npm test` 里的 `domains-test.mjs` 跑的是同一批断言）：

```bash
npm --prefix dsh-adjudication test          # 1822 条领域断言 + 各层门禁
node dsh-adjudication/domains-test.mjs      # 只看 19 个域：19 ran, 0 failed, 0 skipped
```

`plan` 的「候选→准入 / 捆数」与逐域规则数、工具数来自真实插件路径（`adjudication_plan` +
loader 装配结果），演示脚本见「端到端演示」一节。


---

## ⚠️ 损失取向是这套东西里最危险的一个旋钮

引擎里唯一一个「配错了会出事故」的默认值，就是它。

- **`precision-first`** —— 误报是贵的。复核者是事实核查员，**证据不足以证明就不提**。这是 open-code-review 的默认，对「建议性评审」是对的。
- **`recall-first`** —— **漏检是贵的**。复核者只删除被证据**正面否定**的，存疑的一律保留并标注待人工确认。

**十个领域**被标定为 recall-first：风控合规、数据工程、算法模型、技术测试、算子设计、需求调研、市场调研、逆向工程、用户反馈、需求对齐（其余九个是 precision-first；以各领域 `index.js` 的 `lossOrientation` 为准，上表逐域列了）。理由是同一个：这些领域里「我们审过了，没问题」这句话如果是假的，代价远高于多出几条噪音。

> **两层表面，以及它们的关系（t52 起被机械钉住）**：`domains/<id>/` 里的 v2 包按 id 覆盖
> `lib/domains.js` 的内置 pack。内置的那 19 个里有 **9** 个 recall-first，v2 里有 **10** 个 ——
> 差别是 **`algo-model`**：内置记录写的是 `precision-first`，v2 领域包改成 `recall-first`。
>
> - **系统提示里那一行**是从**当前注册表**派生的（不是从常量），所以目录发现之前它报内置的 9 个、
>   发现之后报生效的 10 个；发现尚未发生时它会**明说**自己说的是内置回退表面、并以
>   `adjudication_domains` 的结果为准，发现之后这句自动消失。
> - **`lib/domains.js` 的 `RECALL_FIRST_DOMAINS`** 是一条**关于内置表面**的导出（它自己的注释
>   也是这么写的），用于「不依赖 `domains/` 目录」的场合，**不**由系统提示读取。
>   两者不是同一个问题，`lib/kernel-test.mjs` §18 把两层各自钉住：
>   内置表面上「提示行 === `RECALL_FIRST_DOMAINS` 且带说明」，v2 表面上
>   「提示行 === `adjudication_domains` 报的 recall-first 集合、含 `algo-model`、且**不等于**该常量」。

还有一层保护：`security` / `privacy` / `safety` / `data-loss` / `legal` 这类**受保护主题在两种取向下都先于正确性判断被保留**，先否决再谈对错。

> 一个 recall-first 领域的覆盖率若不完整，`adjudication_submit` 会把它标成**未通过**，而不是一个可以忽略的百分比。

### P6 独立复核：跑在哪、看得到什么、看不到什么（t41 起）

`adjudication_submit` 的阶段顺序是固定的：

```
P5 锚点重算 → P6 独立复核（渲染并执行本领域的 reviewPrompts.verify）→ 损失策略取舍（保留/删除）→ P7 覆盖度
```

- **P6 只产出裁决，不决定准入**：保留/删除仍然由上面那个「最危险的旋钮」`lossOrientation` 与受保护主题决定。P6 的裁决报在 `review.verify.verdicts` 里，供人看、供断言。
- **P6 只能看到发现清单**：上下文逐键构造，只含契约声明的 `{domain, pack, target, orientation, findings}`——没有规则原文、没有本轮工作单、没有 P4 的推理过程。
- **P6 拿不到领域取证工具**：子代理请求显式带 `toolFilter: { allow: [] }`。独立复核不该用被复核的那套工具再查一遍。
- **降级不静默**：宿主没有 `ctx.subagents`/`ctx.llm` 时 `review.verify.ran === false` 并给出原因（报告里仍打出 P6 段——「没跑」与「跑过且通过」在文本上必须可区分）；预算耗尽、取消、子代理未 `completed` 各有稳定 code，**绝不当成「没有被推翻的发现」**。
- **折 verdict 到 finding 有白名单**：`path/start/end/anchored/anchorTier/anchorVia/anchorLocator` 加上域自己的元数据 `code/detail/tier/locator/scope/stale/staleCheck/ambiguousIn/ref/refDomain/refForm/refBasis/refBasisDetail`。白名单而非展开，是为了让 P4 的材料从 finding 上**不可达**。
- **跑没跑，读机器可读字段**：`adjudication_submit` 返回 `review.verify`（`ran / mode / degraded / code / rounds / contextFields / prompt.source / toolFilter / verdicts / errors / reason`），不要解析 summary 文本。

> 这一节之所以存在：在 t41 之前，`reviewPrompts.verify` **全仓没有任何运行期渲染者**——声明、契约校验、装载都在，运行期没人渲染；名为「P6」的那段代码是确定性损失策略，一个字都不读提示词。于是 19 个域里那条「P6 文本 ≠ P4 文本」的自断言在生产路径上永远无法触发。契约 §1.4 记录了修法与断言。

---

## 加一个新领域（这就是「以后再注册其他工具」）

领域包是**纯数据对象**。加第二十个领域不需要动引擎、不需要动工具、不需要让模型重新学任何 schema。

### 方式一：写进 `lib/domains.js`

```js
export const myDomain = {
  id: 'my-domain',              // 小写 kebab-case，工具名由它派生
  title: '我的领域',
  category: 'A',                // A 审定型 / B 构建型 / C 探索型 / D 关系型
  keywords: ['my', 'domain'],
  summary: '一句话说明这个领域审什么。',
  lossOrientation: 'precision-first',
  status: 'ready',

  // P0：候选集是什么，能不能确定性枚举
  candidateSet: { kind: 'my-candidates', description: '...' },

  // P1：闸门
  gate: { include: [], exclude: ['**/node_modules/**'], extensions: null },

  // P2：什么让两个候选适合放在一起判
  bundleKey: 'module',

  // P5：锚点 —— 必须是引擎能独立重算的东西
  anchor: { kind: 'my-anchor', description: '...', verify: 'engine-recomputable' },

  // P6：独立复核者 + 受保护主题
  criticism: { kind: 'fact-checker', description: '...' },
  protectedSubjects: ['security'],

  // P3：规则库，按 glob 匹配、声明顺序首个命中生效
  rules: [
    { name: 'rule-a', match: ['**/*.ts'], text: '规则正文……' },
  ],

  // P4：给模型的有界角色
  prompt: { role: '你是……', instruction: '……' },
}
```

### 方式二：独立包，通过服务注册（解耦路线）

下游包不 import 本插件的任何东西，只依赖一个服务键：

```js
// my-company-dsh-domain-xyz/index.js
export const name = 'my-domain-xyz'
export const inject = ['adjudication']

export function apply(ctx) {
  ctx.effect(() => ctx.adjudication.registerDomain({
    id: 'xyz',
    title: '……',
    category: 'A',
    lossOrientation: 'recall-first',
    anchor: { kind: 'xyz-id' },
    rules: [],
  }), 'xyz-domain')
}
```

它的 `cordis.patch.yml`：

```yaml
- insert:
    - id: my-domain-xyz
      name: 'my-company-dsh-domain-xyz'
```

宿主若不认这个服务键，还有一条不依赖服务总线的路：

```js
import { getSharedRegistry } from 'dsh-adjudication'
const dispose = getSharedRegistry()?.register(pack)
```

**注册返回 disposer**，与 harness 里其它注册表一致：那个 cordis plugin row 卸载时，领域自动撤销。

### 校验

`validateDomain(pack)` 会检查必填字段、id 形态、category、损失取向、anchor、rules。内置库用 `strict: true`（非法即抛），第三方注册用 `strict: false`（跳过并告警），所以一个坏包不会拖垮整个插件。

---

## 配置

`cordis.patch.yml` 那行的 `config`：

```yaml
- insert:
    - id: adjudication
      name: dsh-adjudication
      config:
        domains: all                    # 'all' 或领域 id 数组
        domainTools: full               # 'full' | 'entry'
        promptSection: true             # 是否注入那段简短的系统提示
        promptSectionOrder: 118
        gate:
          maxCandidates: 400
          maxFileBytes: 1048576
        bundle:
          minFiles: 4                   # 少于这个数直接不拆捆
          lineThreshold: 200            # 单捆行数上限，超过整组降级逐项
          maxPerBundle: 10
        budget:
          maxToolCalls: 100
          maxExcerptLines: 500
          maxSearchHits: 100
        lossOrientation: precision-first  # 领域包未声明时的兜底
```

---

## 验证

```bash
npm test              # 全套：契约 + 导入图 + 运行时机制 + 19 个领域 + 引擎/插件 + 真实 Cordis 挂载
npm run test:contracts # 只用契约自检    npm run test:kernel  # 只用运行时机制
npm run test:domains   # 只跑 19 个领域  npm run test:unit    # 只用假上下文的引擎/插件
npm run test:mount     # 只用真实 Cordis
npm run pack:check     # npm pack --dry-run：检查发布清单
```

| 层 | 断言数 | 说明 |
|---|---:|---|
| `contract-test.mjs` | 38 | 契约常量/校验器自洽，含引擎档位双向对账与交付物自洽性（`-text` 例外） |
| `lib/imports-check.mjs` | 129 模块 | 每个具名相对导入都能真的解析（一次性消灭「模块加载失败」） |
| `lib/kernel-test.mjs` | 98 | 契约 v2 运行时机制：扩展点接线、目录发现、P4/P6、锚点档位双向断言、提示词两层表面 |
| `domains-test.mjs` | **19 ran / 0 failed / 0 skipped**（1822 条） | 十九个领域各自的 `test.mjs`，跑 P0→P7 |
| `smoke-test.mjs` | 45 | 引擎与插件（假上下文） |
| `mount-test.mjs` | 13 | 真实 `@deepseek-ai/cordis` 挂载 |

**表格里的 kernel 数字不是手抄的**：`lib/kernel-test.mjs` 收尾会把**自己实际通过的条数**与
写在文档里的三处期望值（本表这一行、`docs/domain-contract-v2-runtime.md` 的「现 N 条」与命令清单里的
`N passed`）逐处机械比对，对不上就打印 `MISMATCH` 并以非零码退出 —— 加一条断言后忘记改文档，
`npm test` 会当场告诉你，而不是等下一个读者发现。

**判据不是「本机工作树全绿」，而是「干净检出全绿」** —— 提交只 commit 了工作树而 HEAD 缺文件，
本机照样全绿：

```bash
git archive HEAD | tar -x -C /tmp/head-check && (cd /tmp/head-check && npm test)
# 期望 EXIT=0，且输出里有 `domains: 19 ran, 0 failed, 0 skipped`
```

**`smoke-test.mjs`** —— 无测试框架、无依赖。覆盖：插件挂载/卸载、按需工具生命周期（激活/幂等/卸载/未知领域）、下游注册与撤销、P1 闸门顺序与 include 短路、P2 分捆短路与降级不丢项、P3 规则选择与渲染、P5 三级锚定（含「歧义时拒绝猜测」「转述不锚定」）、P6 两种损失取向与受保护主题否决、P7 覆盖度、以及 plan→anchor→submit 端到端。

**`mount-test.mjs`** —— 在**真实的 `@deepseek-ai/cordis` Context** 上挂载（真 fiber、真 effect 回收）：

```bash
node mount-test.mjs "C:/path/to/node_modules/@deepseek-ai/cordis"
# 或 DSH_CORDIS=<同样的路径>；找不到安装时自动 SKIP 而不是失败
```

它和上面那个不是重复的。假上下文有一个致命盲区：**它不可能知道宿主的未成文规矩**。本插件的第一版就被这样一条规矩杀掉过 —— Cordis 的 `ctx.set(name, value)` 在该名字未被 `provide` 过时会抛 `cannot set property "x" without provide`；异常发生在 `apply` 内部，Cordis 把 fiber 标记为 FAILED 并**回滚了这个插件刚注册的全部工具**，表现是「挂载成功然后悄悄消失」。用和被测代码同一套假设写出来的 mock，永远找不到这类 bug。

另外，`cordis.patch.yml` 本身也经过真实 Loader 校验：

```bash
dsh --profile <scratch> --patch <本目录>/cordis.patch.yml --dump-config
```

输出应恰好是那一行 `id / name / config`，证明 patch 方言与配置对象都能被 DSH 自己的组合器正确解析。

---

## 端到端演示（真实输出）

不需要模型、不需要网络、不需要宿主——一条命令跑完 `plan → anchor → submit`：

```bash
node docs/demo-e2e.mjs                 # 默认 code-review
node docs/demo-e2e.mjs user-feedback   # 换一个领域：recall-first + 图锚点
```

`docs/demo-e2e.mjs` 注入一个**假**的 `ctx.subagents`（P4/P6 需要一个推理服务；演示的是「引擎怎么用服务」，
不是「模型答得好不好」），其余全部走真实工具。`code-review` 的真实输出：

```text
# 端到端演示：code-review   （fixture: happy-path.json）

① 工具面（未激活）   6 个：adjudication_domains, adjudication_activate, adjudication_deactivate, adjudication_plan, adjudication_anchor, adjudication_submit
② 激活后注册               7 个：adjudicate_code_review, adjudicate_code_review_plan, adjudicate_code_review_rules, adjudicate_code_review_evidence_read_lines, adjudicate_code_review_evidence_search_diff, adjudicate_code_review_evidence_enclosing, adjudicate_code_review_review

③ adjudication_plan
  候选 → 准入             5 → 5（排除 0）
  候选集来源               candidateSource（领域自己的枚举器）
  分捆                  2 捆：'src'(3 路径/27 规则) 'pkg'(2 路径/25 规则)
  bundleKey           applied=true strategy=directory source=derived

④ adjudication_anchor   （用例 small-change.json）
  裁决                  anchored / declared-locator（via=anchorVerifier）
  位置                  src/config.ts:3-3
  summary             已锚定：src/config.ts:3-3（declared-locator，经 code-review 的 anchorVerifier）

⑤ adjudication_submit
  保留 / 未锚定            1 / 0（未锚定的明细 0 条）
  覆盖率                 1/5 = 0.2（complete=false required=false）
  P6 独立复核             ran=true mode=subagents source=reviewPrompts.verify 裁决=1 条
  复核者                 fact-checker

--- 报告（前 10 行）---
| # 代码评审 — 判定报告
| 对象：demo
| 损失取向：precision-first　复核者：fact-checker 事实核查（只看证据能否证明）
| 锚点重算：code-review 的 anchorVerifier（kind=diff-line）
| ## 结果
| 提交 1 条，引擎重算后已锚定 1 条，未锚定 0 条（自报的 anchored/start 一律不采信）。
| 复核保留 1 条，丢弃 0 条，受保护主题否决 0 条。
| 按严重度：high 1
| ## P6 独立复核
| 模式：subagents　提示词来源：reviewPrompts.verify　轮次：1

⑥ 卸载后工具面             6 个

✓ 端到端通过：枚举 → 闸门 → 分捆 → 锚点重算 → 有界评审 → 独立复核 → 报告
```

同一个脚本换 `user-feedback`（D 关系型、**recall-first**、锚在反馈图上）时，关键数字变成：
激活 **10** 个工具（6 个取证工具）、20 候选 → 20 准入、**4 捆**（`theme/checkout` 4 路径 / `theme/report` 3 /
`theme/ui` 4 / `doc/feedback/ledger.json` 9，各注入 25 条规则）、锚点 `declared-locator`、
覆盖率 **1/20 = 0.05 且 `required=true`**（recall-first 的覆盖率不完整 = 未通过）、复核者 `triage`。

**P4/P6 的真实位置**：`ctx.subagents` 由宿主提供时 P4 逐捆跑（`adjudicate_<id>_review`），
P6 在 `adjudication_submit` 内对**已锚定**的发现跑一次，两者上下文互不可见——细节见
[`docs/domain-contract-v2.md`](docs/domain-contract-v2.md) §1.4 与上面的「P6 独立复核」一节。

---

## 已知限制（诚实清单）

1. **没有导出 Schemastery `Config`。** 本插件刻意做到**零运行时 import**：本地路径安装走 pnpm 的 `link:`，不会安装插件的 dependencies；非 `@deepseek-ai/dsh-*` 的 peer 也不保证被 profile 的运行时解析器映射。依赖为零是它在任何宿主上都能加载的原因。代价是配置只有 `apply(ctx, config)` 里的普通对象合并，没有 schema 校验、也不出现在 `--dump-config-schema` 里。要补：把 `@deepseek-ai/schemastery` 加进 peerDependencies 并导出 `Config`。
2. **锚点没有 LLM 兜底层。** open-code-review 的第三级是让模型重定位；本插件**故意不做**——模型猜出来的锚点不是引擎能验证的锚点，而这一层的全部意义就是引擎能独立重算。代价是逐字抄写不精确的发现会变成「未锚定」被降级，而不是被救回来。
3. **规则库是 agent 起草的草稿（20–32 条/域，共 460 条）。** 每一条都标了 `needs-expert-review: true`
   （`rulesStatus: 'draft-v2'`），**未经领域专家审定**。规则库是这类系统的护城河，需要领域专家投入——
   这不是代码能补的：断言能保证「规则被装载、可命中真实路径、标注没被去掉」，**不能**保证「这条规则在
   领域上是对的」。任何交付物不得声称它们已通过专家验证。另一个结构性边界：**名义支持 ≠ 全面支持**——
   每个声明扩展名都有一个能命中文档化真实路径的规则（地板），但子树之外的路径通常只有兜底规则；
   这条边界已写进各域的 `pack.summary`，零规则捆也会在 `plan.summary` 与 P4 提示词里明说「没有匹配到规则」。
4. **激活状态是插件实例级的，不跨会话隔离。** 一个 profile 里所有会话共享同一份注册表与激活集合。
5. **C 探索型领域不承诺有界成本。** `market-research` 与 `reverse-engineering` 的 P0 枚举失效——候选集本身要找出来，这一步的上界无法先验给出。
6. **没有客户端 UI。** 目前只有 host 半体。要加 Web 面板需要 `dsh.client` + `exports["./client"]` + 自建 lazy-CJS 构建（`packages/client/tsdown.client.ts` 不在任何已发布包里，仓库外要自己复刻）。
7. **`kind-mismatch` 只能经 `adjudication_anchor` 触达。** `adjudication_submit` 的 finding 不携带 `kind`（引擎按领域声明的 kind 核验），所以「声明了错误的 claim kind」这条路径在 `submit` 的报告里看不到——它在 `anchor` 上是可触达、可分档位的，方向安全，但确实看不到。
8. **`smoke-test.mjs` 的 `__injectedCallbacks` 恒为 0。** 它是对象字面量里按值快照的原始数组，与 `inject` 的实际回调计数无关。方向安全（将来有人断言它 `> 0` 会直接变红），本轮不修，登记为已知限制。
9. **真实模型 provider 上的 P4/P6 没跑过。** 所有断言用的是假 `ctx.subagents` 服务；`ctx.llm` 兜底路径（`mode: 'llm'`，明确标注 `degraded: true`）同样没在真实 provider 上跑过。引擎保证的是「有界、可取消、不谎报」，不是评审质量。
10. **`mount-test.mjs` 找不到宿主 cordis 时会 SKIP 并且 exit 0。** 换一台没有 `@deepseek-ai/cordis` 的机器，「挂载全过」会退化为「没跑」——它打印 SKIP，但这仍然是判据上的一个洞。
11. **规则库的 460 条规则没有逐条人工复算。** 独立验证抽查了「标注被去掉会变红」等机制性质，没有逐条核对领域正确性（与第 3 条同一个边界）。

## 许可与出处

本插件 **Apache-2.0**（与上游一致），见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

机制与常量移植自 Alibaba [open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0），并在 `lib/engine.js` 的函数注释与 `NOTICE` 里逐处标注了对应源文件。所有移植部分都**经过改造**：上游的代码评审专用逻辑被抽象成由领域包参数化的领域无关原语。一处**有意的偏离**：上游锚定第三级是 LLM 重定位，本插件不实现（理由见「已知限制」）。

领域注册表、十九个领域包、按需工具装载、recall-first 损失取向与测试套件为本项目原创。
