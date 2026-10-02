# 契约 v2 运行时（Contract v2 Runtime）

> 本文说明**运行时实际落地了什么**、怎么配置、以及一个领域拥有者要怎么做才能把自己的领域从
> 「内联声明」搬到 `domains/<id>/`。
>
> **接口的规范定义**在 [`docs/domain-contract-v2.md`](./domain-contract-v2.md)；
> 机器可读常量在 [`lib/contracts.js`](../lib/contracts.js)；
> **动手写第 20 个领域的完整配方**在 [`docs/adding-a-domain.md`](./adding-a-domain.md)。
>
> **本文写于运行时刚落地时（当时 `domains/<id>/` 还是一个空约定）**，第 1–4 节描述的运行时机制
> 至今逐条有效；**状态类叙述已按当前仓库更新**（19 个领域包已建成并被 `npm test` 纳入）。

## 0. 一句话状态

引擎现在真的会读 `bundleKey` / `candidateSet` / `criticism.kind`；`domains/<id>/` 的自动发现、校验、
重名拒绝与五个扩展点的装配已经可用；P4 有界推理回路有了执行器，并且**只在宿主真的挂载了
`ctx.subagents` 或 `ctx.llm` 时才出现**。19 个内联 pack 一字未改，照常工作。

**`domains/<id>/` 目录本身也已建成**：19 个领域包各自八件齐备（`source.js` / `anchor.js` /
`evidence.js` / `prompts.js` / `rules/*.md` / `fixtures/*.json` / `index.js` / `test.mjs`），
合计 460 条规则、87 份 fixture、1822 条领域断言，全部由 `npm test` 的 `domains-test.mjs` 纳入。
逐域的完工状态与实测数字见 [README](../README.md#十九个领域包) 的表。

---

## 1. 文件地图

| 文件 | 状态 | 说明 |
|---|---|---|
| `lib/contracts.js` | t1 新增，t2 微调 | 契约常量 / 工厂 / 校验器。t2 给 `resolveBundleKey` 加了**显式 key 优先**与 `source` 字段 |
| `lib/domain-loader.js` | **t2 新增** | 目录发现、扩展点装配、`rules/*.md` 装载。**零 import**：文件系统以 `io` 注入 |
| `lib/reasoner.js` | **t2 新增** | P4 有界推理回路执行器。零 import，两个服务都是普通对象 |
| `lib/engine.js` | t2 改动 | `critique()` / `runCritiquePanel()` / `report()` 读取并回显 `criticism.kind`（不参与保留/删除） |
| `index.js` | t2 改动 | 可选服务注入、惰性目录发现、`bundleKey` 派生、`input` 入参、证据工具与 P4 工具注册 |
| `lib/kernel-test.mjs` | t2 新增，此后持续加码 | 运行时机制断言，已并入 `npm test`（现 **99 条**；这个数字、README 表格里的同一个数字、以及下面那段命令清单里的 `95 passed`，由该文件收尾的**漂移检查**逐处机械比对 —— 对不上就打印 `MISMATCH` 并以非零码退出，不靠人记得回来改） |
| `cordis.patch.yml` | t2 改动 | 新增 `domainRoot` / `bundleKey` / `reasoner` 三个配置块（全部可选） |

**「零运行时 import」的准确含义**：没有任何**第三方包** import，模块加载期也不需要任何 `node:` 内置模块。
`createNodeIo()` 内部通过**动态** `import('node:fs' | 'node:path' | 'node:url')` 惰性取得两个内置模块，
只在真正要读 `domains/` 时发生；宿主也可以完全绕开它，通过配置注入自己的 `domainIo`。

---

## 2. 配置项

```yaml
config:
  domains: all            # 不变：内置库的选取
  domainTools: full       # 不变
  domainRoot: domains     # 新增：domains/<id>/ 的扫描根

  bundleKey:              # 新增：bundleKey 何时真正参与分捆
    trustDeclaredStrategies: true   # 让内置 pack 声明的 'directory' 生效
    # strategies: { directory: (candidate, params) => ... }  # 或按名注入自定义实现
    # params: { directory: { depth: 2 } }

  reasoner:               # 新增：P4 执行器的边界
    provider: null        # 只有走 ctx.llm 兜底路径时才需要
    model: null
    maxRounds: 8
    maxPromptChars: 24000
    maxFindings: 200
```

- **`bundleKey.trustDeclaredStrategies: false`** 会逐字恢复 v1 的分组行为（按 `entry.key ?? entry.path`），
  用于灰度对比。默认 `true`：`bundleKey` 是 t2 明确要求「真正参与分捆」的字段。
- 无论开关怎么设，**候选自带 `key` 时永远以它为准**；未知策略名不猜、退回按路径分组，
  并把原因写进 `plan.bundleKey.reason`。
- 19 个内置 pack 的 `bundleKey` 只有 `'directory'` 有通用实现，其余（`regulation`/`flow`/`module`/…）
  是领域私有语义，会落到 `applied: false` 并写明原因——这是诚实的降级，不是静默失效。

---

## 3. 三个字段现在的可观测行为

`adjudication_plan` 的返回值新增三个**只增**字段（既有字段与顺序未变）：

```jsonc
{
  "candidateSet": {
    "kind": "diff-hunks",           // pack.candidateSet.kind
    "inputFormat": "unified-diff",  // 文档化输入格式
    "origin": "candidateSource",    // 或 "caller-supplied"
    "bounded": true,                // C 探索型为 false
    "truncated": false,
    "notes": [],                    // 例如「候选集本身要找」
    "excludedBySource": [],         // 源头就排除的项（附原因）
    "problems": []                  // 产出不符合契约时的具体问题
  },
  "bundleKey": {
    "declared": "directory", "strategy": "directory",
    "applied": true, "source": "derived",
    "derived": 5,                   // 实际派生了几项
    "reason": "trustDeclaredStrategies"
  },
  "criticism": { "kind": "fact-checker", "description": "…" }
}
```

- **`input` 入参**：`adjudication_plan` 与 `adjudicate_<id>` 现在接受
  `input: { format, payload }`（与 `candidates` 二选一）。领域没实现 `candidateSource` 时，
  报错是**可执行的**：`领域 "code-review" 没有 candidateSource（P0 枚举器）… 先实现 domains/code-review/source.js`。
  `format` 与领域的文档化格式不符时直接拒绝，不做强制转换。
- **`criticism.kind`**：`adjudication_submit` 的返回值多一个 `criticismKind`，摘要里多一行
  「复核者：fact-checker 事实核查 / triage 分级筛选」。它在**两个地方**被读到：`plan` 的
  `criticism` 与 `submit` 的 `criticismKind`。它**只影响标签与报告**——保留/删除仍由
  `lossOrientation` 决定（19 个 pack 的两者本来就自洽，所以行为未变），它也**不选择** P6 的提示词文本
  （那是一句曾经写在代码注释里的错误说法，运行期从来不是这样；见 `lib/engine.js:610` 的更正注释与
  `docs/domain-contract-v2.md` §1.4）。

---

## 4. P4 有界推理回路

### 4.1 什么时候存在

| 宿主挂载 | `describeReasoner().mode` | 领域 P4 工具 `adjudicate_<id>_review` | 行为 |
|---|---|---|---|
| `ctx.subagents` | `subagents` | ✅ 注册 | 独立上下文 + 工具白名单 + 结构化输出 + 可取消 |
| 只有 `ctx.llm` | `llm`（`degraded: true`） | ✅ 注册 | 单轮、无工具循环，findings 从文本里解析 |
| 都没有 | `none` | ❌ 不注册 | 核心工具面仍是 6 个，P4 留在调用方；`facade.reasoner.run()` 返回 `E_NO_REASONER`，**不抛错** |

注入一律走 `ctx.inject(['subagents'])` / `ctx.inject(['llm'])`，**绝不进静态 `inject`**：静态 `inject`
缺服务会让 fiber FAILED，Cordis 随即回滚这个插件刚注册的全部工具（与 README 记录的
`ctx.set` 未 `provide` 事故同类）。`ctx.inject` 调用本身也包在 try/catch 里，宿主不支持可选注入
只是「没有服务」，不是插件故障。

### 4.2 预算与取消

- **预扣**：每一轮开跑前先 `charge({ toolCalls: 1, text: prompt })`，与引擎既有 lookahead 语义一致；
  `budget.exhausted` 为真时**不启动**新的回路。
- **不静默丢弃**：没跑到的批次进 `skipped[]`，并让 `code: E_BUDGET_EXHAUSTED`。recall-first 领域
  据此在 `adjudication_submit` 里判**未通过**（现有逻辑）。
- **取消**：`execute(args, exec)` 的 `exec.signal` **原样**转发给 `subagents.start({ signal })` /
  `llm.stream({ signal })`（同一个对象，`kernel-test` 用 `assert.equal` 断言）；轮次之间也检查
  `signal.aborted`。子运行 `stopReason !== 'completed'` **一律计为该批次失败**，`aborted` → `E_ABORTED`，
  绝不当作「没有发现」。
- **必须 dispose**：每个 `SubagentRun` 在 `finally` 里 `dispose()`，成功、失败、取消三条路径都走。

### 4.3 能力降级

`outputSchema` / `toolFilter` / `maxDepth` 需要 provider 具备对应 capability；不被支持时 `start()` 会
明确拒绝。执行器会**去掉这三项重试一次**，并把 `outcome.degraded = true` 写进结果——降级是可见的，
不是偷偷关掉保护。`allowCapabilityDegrade: false` 可以关掉这个重试。

### 4.4 给下游的用法

```js
// 通过服务（下游 cordis 插件行）
export const inject = ['adjudication']
export function apply(ctx) {
  const outcome = await ctx.adjudication.reasoner.run({
    pack, target, bundles, signal, parent: exec.agent,
    outputSchema, toolFilter,
    getBudget: () => ctx.adjudication.ledger,
    onCharge: (entry) => { /* 交给宿主记账 */ },
  })
}
```

---

## 5. 领域拥有者迁移配方

目标：**只碰自己的目录**，不编辑任何共享文件。

```bash
mkdir -p dsh-adjudication/domains/<id>/{rules,fixtures}
# 1) index.js          领域包 v2（default export）
# 2) source.js         defineCandidateSource({ kind, inputFormat, bounded, enumerate })
# 3) anchor.js         defineAnchorVerifier({ kind, verify })
# 4) evidence.js       defineEvidenceToolkit({ tools: [...] })，没有就写 { tools: [] }
# 5) prompts.js        defineReviewPrompts({ review, verify })，两者文本必须不同
# 6) rules/*.md        ≥20 个文件，front-matter 含 name / match / needs-expert-review: true
# 7) fixtures/*.json   至少 empty / all-gated-out / happy-path
# 8) test.mjs          对 fixture 跑 P0→P7
```

规则四条：

1. **`index.js` 的 `id` 必须等于目录名**，否则装载器直接拒绝（工具名由 id 派生，不一致会造出幽灵领域）。
2. **声明优先于文件**：`index.js` 里内联的扩展点覆盖同名兄弟文件；`pack.ruleLibrary` 已声明时不再扫 `rules/`。
3. **一条都别凑合**：`validateDomainPackV2` 会拒绝种子级规则库（<20 条）、缺 `needs-expert-review: true`
   的规则、kind 漂移（`candidateSource.kind` vs `candidateSet.kind`、`anchorVerifier.kind` vs `anchor.kind`）、
   与损失取向矛盾的 `criticism.kind`、以及缺边界 fixture 的声明。被拒绝的目录会被**跳过并打印原因**，
   不会半死不活地注册进去。
4. **规则库是草稿**：由 agent 起草并标注 `needs-expert-review: true`，**未经领域专家审定**。
   任何交付物不得声称已通过专家验证。

迁移是**逐个领域**的：目录一旦出现，同 id 的 v2 pack 覆盖内置的 v1 pack，其余 18 个不受影响。

---

## 6. 验证

```bash
npm --prefix dsh-adjudication test
# = node contract-test.mjs      -> 38 passed, 0 failed   契约形状
#   node lib/imports-check.mjs  -> 每个具名相对导入都能解析（129 个模块）
#   node lib/kernel-test.mjs    -> 99 passed, 0 failed   运行时机制（这几个数字不是手抄的：见 §7 末尾的漂移检查）
#   node domains-test.mjs       -> domains: 19 ran, 0 failed, 0 skipped（1822 条领域断言）
#   node smoke-test.mjs         -> 45 passed, 0 failed   引擎与插件
#   node mount-test.mjs         -> 13 checks, all passed 真实 Cordis 挂载
```

**「工作树全绿」不等于「交付物全绿」**：干净检出才是判据。

```bash
git archive HEAD | tar -x -C /tmp/head-check && (cd /tmp/head-check && npm test)
# 期望 EXIT=0 且输出里有 `domains: 19 ran, 0 failed, 0 skipped`
```

另外，更新后的 `cordis.patch.yml` 经**真实 DSH Loader** 解析通过：

```bash
dsh --profile mstest --patch dsh-adjudication/cordis.patch.yml --dump-config
# 输出包含 domainRoot: domains / bundleKey.trustDeclaredStrategies: true /
# reasoner{provider,model,maxRounds,maxPromptChars,maxFindings}
```

`lib/kernel-test.mjs` 覆盖的正是本次验收的七条：扩展点运行时校验（否定用例为主）、
目录发现三路径（发现 / 校验失败跳过 / 重名拒绝）、19 个内置 pack 不受影响、
`bundleKey` 真正分捆（含显式 key 优先与开关回退）、`candidateSet` 与 `criticism.kind` 被读取、
P4 执行器（无服务降级 / 预算 / 取消 / dispose / 能力降级 / 文本兜底解析）、
以及插件对 P4 的可选接线。

---

## 7. 已知限制（诚实清单）

1. **19 个领域包已建成，但规则库仍是草稿。** 460 条规则全部由 agent 起草、全部标
   `needs-expert-review: true`（`rulesStatus: 'draft-v2'`），**未经任何领域专家审定**——
   这是能力边界，不是可以用断言补上的东西。
2. **`bundleKey` 只在领域给出实现时才真分捆。** 四个领域（data-engineering / algo-model /
   market-research / reverse-engineering）给了 `{ strategy, resolve }` 私有实现，分捆真的发生；
   其余声明的通用/领域私有语义若没有实现，会落到 `applied: false` 并在 `plan.bundleKey.reason`
   里如实写明——这是诚实的降级，不是静默失效。
3. **P4 的质量上限取决于宿主模型与 provider。** 执行器保证的是「有界、可取消、不谎报」，
   不保证评审质量；`mode: 'llm'` 是明确标注的降级路径。
4. **`ctx.llm` 兜底路径的请求形状是最小可用集**（`provider`/`model`/`system`/`messages`/`signal`）。
   它按 DSH 的 `GenerateOptions` 拼装，但没有在真实 provider 上跑过——有 `ctx.subagents` 的宿主
   永远走不到这条路。
5. **目录发现是惰性的**：第一次调用 `adjudication_domains` / `adjudication_activate` /
   `adjudication_plan` / `adjudication_submit` 时才扫描。这样 `apply()` 保持同步、现有断言不受影响，
   代价是「刚放进来的目录要等一次工具调用才可见」。
