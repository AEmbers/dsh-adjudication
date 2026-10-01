# CHANGELOG

## 0.1.0

首个可用版本。

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

机制与常量移植自 Alibaba open-code-review（Apache-2.0），`lib/engine.js` 注释逐处标注对应源文件。
