# CHANGELOG

## 0.1.0 — 十九个领域包（未发布，本文件靠前的条目最新）

（同一版本号仍在开发中。这一节描述「从只有声明到端到端可运行」的落地；下面两节记录契约 v2 与 v1 的机制。）

### 新增

- **十九个领域包全部八件齐备**：`domains/<id>/{source,anchor,evidence,prompts,index}.js` +
  `rules/*.md` + `fixtures/*.json` + `test.mjs`。合计 **460 条规则**、**63 个取证工具**、
  **87 份 fixture**、**1822 条领域断言**，全部由 `domains-test.mjs` 纳入 `npm test`
  （`domains: 19 ran, 0 failed, 0 skipped`）。
  - 逐域的完工状态、规则数、工具数、断言数与「候选→准入/捆数」实测见 README 的
    「十九个领域包」一节；两处「无独立证据」也在那里如实标出。
  - **P0 枚举器真的在枚举**：十九个域的 `plan.candidateSet.origin` 全是 `candidateSource`
    （领域自己的枚举器产出），没有一个依赖调用方手工喂候选集。
- **端到端演示脚本** `docs/demo-e2e.mjs`：一条命令跑完 `plan → anchor → submit → 卸载`，
  不需要模型、网络或宿主（P4/P6 用注入的假推理服务）。README 里贴了它的真实输出。
- **新导出 `validatedEngineVerdict()`**（`lib/engine.js`，经 `dsh-adjudication/engine` 子路径可用）：
  引擎自己产出的锚点裁决现在也过 `validateAnchorVerdict`，不合契约就降级成
  `unanchored/invalid-verdict`（带违规原因，不抛异常）。
- **随包文档** `docs/`：`domain-contract-v2.md`（规范）、`domain-contract-v2-runtime.md`
  （运行时，原在工作区）、`adding-a-domain.md`（写第 20 个领域的配方）、`review-antipatterns.md`
  （15 种「断言看着在守、其实没守」的形态）。

### 变更（引擎行为的改动 —— 本版本尚未发布，因此这些改动暂时没有对外影响）

- **锚点档位词汇表的发布前收敛。** `ANCHOR_TIERS` **9 → 13**、`TRUSTED_ANCHOR_TIERS` **3 → 4**。
  这**不是**一次对外删除：整个档位词汇表（包括那个 `domain-locator`）**从未出现在任何已提交、
  更未出现在任何已发布的状态里** —— 承载它的 `lib/contracts.js` 的第一个提交就是本版本，
  此前的 `acb1ae0` 里没有这个文件（自证命令见下）。所以下面写的是**发布前的内部设计纠正**，
  没有任何第三方拿到过带旧词汇表的版本，也就没有「行为变化」可谈：
  - **`domain-locator` 被删掉**，理由是它在仓库里**没有任何生产者**：19 份 `domains/<id>/anchor.js`
    全量扫查（包括它当初想服务的 ID/图/表/图层家族）报的都是 `declared-locator`，
    `lib/engine.js` 的通用阶梯也返回不了它；唯一用到它的是 kernel 测试夹具。
    它被加进来时是为了让「没有行号」的家族能合法地报 anchored，而
    `validateAnchorVerdict` 从第一天起就允许 anchored 裁决带**非空 `locator` 对象**，
    所以这份能力从来没缺过。
  - **引擎实际会返回的四个档位补进了声明**：`declared-document` 列为**受信**（引擎三级锚定的
    第一级，`smoke-test.mjs` 一直在断言它）；`sliding-window` / `no-excerpt` / `invalid-verdict`
    列为**不受信**（只能出现在未锚定裁决上）。此前这四个档位**有生产者、没名字**，
    而通用阶梯不经过校验器 ⇒ 契约描述不了自己的引擎，这才是本轮真正修掉的东西。
  - 值钱的那半是**守卫本身**：两条**双向**运行期断言（`lib/kernel-test.mjs` §16）——
    (a)「每个**被声明**的档位都有真实生产者」、(b)「每个**被生产者返回**的档位都被声明」。
    两个方向**各自都曾经是红的**，而且各自只抓到不同的东西：方向 (a) 在移除前抓到 **1 个**
    「声明了却没有生产者」的档位（`domain-locator`），方向 (b) 在补声明前抓到 **4 个**
    「有生产者却没名字」的档位（`declared-document`、`invalid-verdict`、`no-excerpt`、`sliding-window`）。
    只做一个方向等于只修一半 —— 这份守卫留下的原因就在这里。
  - **自证（可执行）**：`git show acb1ae0:lib/contracts.js` → `fatal: path ... not in 'acb1ae0'`；
    `git log --all --diff-filter=A --oneline -- lib/contracts.js` → 只有本版本的提交；
    对每个提交执行 `git show <rev>:lib/contracts.js | grep -c "^  'domain-locator':"` → 全为 `0`。
- **系统提示的 recall-first 名单现在说明自己描述的是哪一层表面**（t52）：那段文本一直是从
  **当前注册表**派生的（不是从 `lib/domains.js` 的 `RECALL_FIRST_DOMAINS` 常量），
  但它在**首次工具调用触发目录发现之前**渲染时，注册表还是内置 v1 记录 —— 那时它报 9 个，
  发现之后报 10 个（`algo-model` 的 v2 包是 recall-first），两句话读起来却像同一句。
  现在发现尚未发生（或 `domains/<id>/` 没提供 v2 包）时，这一行会明说
  「以上为内置回退表面的名单 …以 `adjudication_domains` 的结果为准」；发现之后该说明自动消失。
  钉住它的是 `lib/kernel-test.mjs` §18 两条断言：内置表面上「名单 === `RECALL_FIRST_DOMAINS` 且带说明」，
  v2 表面上「名单 === `adjudication_domains` 报的 recall-first 集合、含 `algo-model`、且**不等于**那个常量、
  说明消失」；三个变异（把名单写死成内置九项 / 去掉说明 / 说明永不消失）分别把对应的那一半变红。
- **P6 独立复核真的会跑**（此前 `reviewPrompts.verify` 全仓没有任何运行期渲染者，
  名为 P6 的那段代码是确定性损失策略、一个字都不读提示词）：`adjudication_submit` 现在按
  「P5 锚点重算 → **P6** → 损失策略取舍 → P7 覆盖度」执行，P6 上下文只含
  `{domain, pack, target, orientation, findings}`，子代理请求显式 `toolFilter: { allow: [] }`，
  只产出裁决、**不决定准入**。返回值新增 `review.verify`
  （`ran / mode / degraded / code / rounds / verdicts / errors / contextFields / prompt.source / toolFilter`）。
- **P6 的「答非所问」不再被折叠成「没有要推翻的」**：模型给出的答复无法解析成裁决列表时，
  报 `code: 'E_VERDICT_UNPARSED'`、`ok: false`、`ran: true`、`verdicts: []`，报告里写
  「未得到裁决：复核者的答复无法解析」——与「复核者没有要推翻的」在机器可读面与文本上都可区分。
- **P4/P6 独立性有两道闸门**：校验期拒绝「同一个函数干两份活」（`review === verify`），
  运行期在同一上下文下渲染 P4 与 P6，**逐字相同就拒绝启动子代理**并报 `E_P6_NOT_INDEPENDENT`
  （`ran: false`、`rounds: 0`）。19 个领域实测 0 触发；每域自己的 `assert.notEqual` 仍是需要的第三道。
- **`adjudication_anchor` 的 `kind` 参数真的被读**：传入时按传入的 kind 核验，省略则取该领域声明的
  anchor kind（此前该参数被静默忽略）。
- **`maxCalls` 真的被执行**：每个领域每个取证工具在**一次激活**内计数，超限抛
  `E_BUDGET_EXHAUSTED` 并引用声明值；`deactivate` + `activate` 重置预算（此前只在契约层声明）。
- **`selectRules().unmapped` 修正**：不再把「已被注入规则命中」的路径列为未覆盖
  （此前的实现每条规则只消掉第一条命中路径）。
- **`npm test` 的组成**：`contract-test → imports-check → kernel-test → domains-test → smoke-test → mount-test`；
  `lib/imports-check.mjs` 逐条验证每个具名相对导入真的能解析。

### 修复

- **发布包能自己跑测试**：`package.json` 的 `files` 现在含 `contract-test.mjs` /
  `domains-test.mjs` / `smoke-test.mjs` / `mount-test.mjs`（此前缺失 ⇒ 装包后 `npm test` 第一步就失败）。
  判据是真做一次 `npm pack` → 解包 → `npm install` → `npm test`（见 t15 报告）。
- **交付物自洽性**：`.gitattributes` 给 `domains/user-feedback/fixtures/*.json` 加 `-text`——
  生成器故意输出 CRLF 且产物比对是字符串相等，`eol=lf` 归一化会让**干净检出**红、
  工作树却全绿。`contract-test.mjs` 与 README / 契约文档都钉住了这条与它的复现命令。

### 诚实清单

- **460 条规则全部由 agent 起草**、全部标 `needs-expert-review: true`（`rulesStatus: 'draft-v2'`），
  **未经任何领域专家审定**。断言保证的是「规则被装载、可命中真实路径、标注没被去掉」，
  不保证「这条规则在领域上是对的」；`RULE_PROVENANCE.expertValidated` 保持 `false`，
  任何交付物不得声称已通过专家验证。
- **真实模型 provider 上的 P4/P6 未跑过**：全部断言用假 `ctx.subagents` 服务；`ctx.llm` 兜底路径
  （`mode: 'llm'`，明确标注 `degraded: true`）同样未在真实 provider 上跑过。
- **名义支持 ≠ 全面支持**：每个声明扩展名都有能命中文档化真实路径的规则（地板），子树之外通常只有
  兜底规则；边界写在各域 `pack.summary`，零规则捆会在 `plan.summary` 与 P4 提示词里明说。
- 两处「无独立证据」与其余已知限制见 README「已知限制」。
- 与上游 open-code-review 的对照仍是**静态**的（本机无 Go，未构建上游二进制）。

## 0.1.0 — contract v2

（同一版本号，仍在开发中：以下条目描述契约 v2 的落地，尚未发布。）

### 新增

- **领域契约 v2** `lib/contracts.js`：五个扩展点（candidateSource / anchorVerifier /
  evidenceTools / reviewPrompts / ruleLibrary）的常量、工厂与校验器；`validateDomainPackV2`
  是 v2 目录的完工闸门
- **领域目录运行时** `lib/domain-loader.js`：`domains/<id>/` 的发现、装配、重名拒绝与
  `rules/*.md` 装载。模块自身零 import，文件系统以 `io` 注入
- **P4 有界推理回路** `lib/reasoner.js`：主路径 `ctx.subagents`，兜底 `ctx.llm`；预算预扣、
  可取消、子运行非 completed 一律计失败（绝不当作「没有发现」）
- **参照域 `domains/code-review/`**：第一个端到端完工的领域（8 件交付物齐备）
  - `source.js` — unified diff → 每个 (文件, hunk) 一个候选
  - `anchor.js` — diff 行滑窗；行号一律重算，矛盾/歧义判未锚定
  - `evidence.js` — 3 个有界取证工具，按需装载
  - `prompts.js` — P4 评审与 P6 独立复核两份**不同**的提示词
  - `rules/*.md` — **31 条 agent 起草的规则草稿**，全部标 `needs-expert-review: true`
  - `fixtures/` — `empty` / `all-gated-out` / `happy-path` / `small-change`，各带正负锚点例
  - `test.mjs` — P0→P7 全链路，79 条断言
  - `COMPARISON.md` — 与上游 open-code-review 的**静态对照**（本机无 Go，未构建二进制）
- **领域测试运行器** `domains-test.mjs`：自动发现并运行 `domains/<id>/test.mjs`，
  已串入 `npm test`。**新增领域不需要改任何共享文件**
- **三个只声明字段真正生效**：`bundleKey` 参与分捆、`candidateSet` 由候选源枚举、
  `criticism.kind` 被读取并标注（不参与保留/删除计算——那是 `lossOrientation` 的职责）

### 变更

- 原有 `smoke-test.mjs` / `lib/kernel-test.mjs` / `mount-test.mjs` 的若干断言改用
  **空内存 io**（`{ domainIo: createMemoryIo({}) }`）或改为断言**具体工具名**：
  这些断言测的是「内置库如何」，而 `apply(ctx, {})` 会读真实 `domains/` 目录。
  每条被改的断言都在原地注释了原因，**没有一条被删除或放宽**。
  内核断言数 48 → 51；43 + 13 条既有断言全部保持通过。

### 诚实清单

- 31 条规则是 **agent 起草的草稿**，未经领域专家审定；`RULE_PROVENANCE.expertValidated`
  保持 `false`，任何交付物不得声称已通过专家验证。
- 与上游的对照是**静态**的（读源码常量与谓词顺序），未构建上游 Go 二进制，
  因此没有运行期逐文件对照数据。
- `domains/code-review/` 的 P4 主路径经 fake service 断言；`ctx.llm` 兜底路径
  **未在真实 provider 上跑过**。

## 0.1.0 — v1

### 新增

- **确定性引擎** `lib/engine.js`（P0–P3 / P5 / P7）
  - `gate()` 八道有序闸门，`secret` 优先于一切用户规则；显式 include 短路放行
  - `bundle()` 分捆，小变更短路、超限降级且不丢候选
  - `selectRules()` / `renderRules()` 声明顺序首个命中生效；单规则裸文本（保 prompt 前缀稳定）
  - `resolveAnchor()` 三级锚定：指名文档滑窗 → 跨文档唯一命中搬迁 → 未锚定；**歧义拒绝猜测**
  - `critique()` / `runCritiquePanel()` 两种损失取向 + 受保护主题先于正确性判断否决
  - `coverage()` / `report()` 覆盖度证明与报告封套
- **领域注册表** `lib/registry.js`：`registerDomain` 返回 disposer，`validateDomain` 校验，非法包跳过而不拖垮插件
- **19 个领域包** `lib/domains.js`：A 审定型 10 / B 构建型 4 / C 探索型 2 / D 关系型 3；9 个标定为 recall-first
- **按需工具装载** `index.js`：常驻 6 个核心工具；领域工具（3/领域）只在 `adjudication_activate` 后注册，`adjudication_deactivate` 或插件卸载时一次性撤销
- **可选系统提示 section**：只宣告 6 个核心工具与 recall-first 领域清单，不枚举全部领域（否则与按需设计自相矛盾）
- **下游扩展两条路**：`ctx.get('adjudication')` 服务查找，或 `getSharedRegistry()` 模块访问器
- **`smoke-test.mjs`**：43 条断言，零依赖

### 已知限制

见 README「已知限制」。要点：无 Schemastery `Config` 导出（换取零运行时依赖）、锚点无 LLM 兜底层（有意为之）、规则库为种子级、无客户端 UI。

### 出处

机制与常量移植自 Alibaba open-code-review（Apache-2.0），`lib/engine.js` 与
`domains/code-review/{anchor,source,index}.js` 注释逐处标注对应源文件；
细则见 `NOTICE`。
