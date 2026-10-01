# CHANGELOG

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
