# code-review 与上游 open-code-review 的对照（静态对照，未构建）

> 本文只做**静态对照**：逐条读上游源码里的常量与谓词顺序，与本插件的实现比对。
> **上游 Go 二进制没有构建**——本机没有 `go` 可执行文件（`go version` → 命令不存在，
> `Program Files\Go`、`%LOCALAPPDATA%\Programs\Go`、`C:\Go` 均不存在），所以
> `ocr delegate preview` 的**运行输出没有生成**，本文不含任何运行期对照数据。
> 凡是我无法从源码读出的，一律标注为「未验证」，不推测。

对照的两侧：

| 侧 | 位置 | 形态 |
|---|---|---|
| 上游 | `open-code-review/internal/` | Go，Apache-2.0 |
| 本插件 | `dsh-adjudication/lib/engine.js` + `domains/code-review/` | JavaScript，零运行时依赖 |

---

## 1. P0 候选集：同一份输入，两侧各自怎么枚举

| | 上游 | 本插件 |
|---|---|---|
| 输入来源 | `git diff`（`internal/diff/git.go`），或 workspace 未跟踪文件 | 调用方给的 unified diff 字符串（`source.js:enumerate`） |
| 解析 | `internal/diff/parser.go` + `hunk.go`（`hunkHeaderRe = ^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`） | `source.js:parseUnifiedDiff`，同一条正则 |
| 候选粒度 | 整个**文件**（`model.Diff`）是一个分派单位 | 每个 **(文件, hunk)** 一个候选 |
| 越界处理 | 解析失败 → provider 错误 | 无法识别的行保留为上下文并写进 `notes` |

**唯一的实质差异是粒度**：上游一个文件是一次评审调用，本插件一个 hunk 是一个候选，
再由 P2 重新捆成评审调用。这不改变「哪些文件会被看到」，但改变「一次调用看多少内容」。

本插件按 hunk 枚举是 `lib/contracts.js` §5 对 `code-review` 的既定声明
（`candidates: 'one per (file, hunk)'`），不是本次实现临时选的。

---

## 2. P1 闸门：谓词顺序（**逐条对照**）

上游 `internal/agent/selection.go:70 whyExcluded` + `selection.go:43 selectFiles`：

```
1  IsBinary                          -> binary
2  IsSecretPath(OldPath) || IsSecretPath(NewPath)   -> secret_exclude
3  FileFilter.IsUserExcluded(path)   -> user_exclude
4  FileFilter.HasInclude() && IsUserIncluded(path)  -> （立刻 return ExcludeNone，跳过 5/6）
5  ext != "" && !IsAllowedExt(ext)   -> unsupported_ext
6  IsExcludedPath(path)              -> default_path
── selectFiles 里，静态闸门之后 ──
7  IsDeleted                         -> deleted
8  CountTokens(Diff) > limit         -> too_large（limit 由 MaxTokens 推出）
```

本插件 `lib/engine.js:192 DEFAULT_GATE_PREDICATES`：

```
1  binary         c.binary
2  secret         c.secretMatch 或内置凭据 glob
3  deleted        c.deleted
4  user-exclude   命中 ctx.exclude
5  user-include   命中 ctx.include -> GATE_ALLOW（跳过其余全部）
6  extension      ctx.extensions 不含该后缀
7  default-path   命中 DEFAULT_EXCLUDE_PATTERNS
8  too-large      c.bytes > ctx.maxFileBytes
```

**顺序差异（两条，均已核实）**：

1. **`deleted` 的位置不同。** 上游把删除检查放在静态闸门**之后**（`selectFiles` 里，第 7 位），
   本插件放在第 3 位（紧接 `secret` 之后）。两者都在 `user-include` 之前/之后的差别只影响
   **报告里写哪个原因**，不影响准入结果：被删除的文件无论在哪一步都会被排除。
   本插件把它提前，是因为 `deleted` 比 `user-exclude` 更本质——一个已经被删除的候选不该
   因为调用方写了个 exclude 规则而被报告成「被规则排除」。
2. **`user-include` 的短路语义一致。** 上游在第 4 步 `return ExcludeNone`，本插件返回
   `GATE_ALLOW` 并 break（`engine.js:174` 的注释解释了为什么它必须让过 `extension` 与
   `default-path`、但不能让过 `secret`）。**这一条是对齐的**，且上游同样把 `secret` 放在
   include 之前（`selection.go:78` 的注释写着 "no include glob can admit a credential path"）。

---

## 3. 支持的扩展名：**本插件的审查面明显更窄**

上游 `internal/config/allowlist/supported_file_types.json`：**115 个**扩展名，
包含 `.css` `.scss` `.html` `.xml` `.json` `.yaml` `.yml` `.toml` `.ini` `.env`
`.ipynb` `.vue` `.svelte` `.proto` `.tf` 等。

本插件 `domains/code-review/index.js:gate.extensions`：**26 个**，
只覆盖源码与配置：`.go .ts .tsx .js .jsx .py .rs .java .kt .cs .rb .php .swift .c .cc .cpp .h .hpp .sql .sh .ps1 .vue .svelte .yml .yaml .toml`。

**这是个真实差异，且方向是「更保守」**：同一份 fixture diff，上游会把 `README.md`
记为 `unsupported_ext`（两侧一致，`.md` 都不在表里），但本插件会把上游允许的
`src/schema.json`、`style.css` 记为 `unsupported_ext` 而上游会放行。
→ 对同一份变更集，**本插件的准入集合是上游的子集**（在扩展名维度上）。
这是 v1 pack 的既有声明，本次迁移**逐字保留**，没有借机扩大。

---

## 4. 凭据路径：**本插件的名单宽得多**

| | 条目数 | 含 `.env`？ | 含 `*.pem/*.key/*.p12`？ | 含 `.aws/credentials`？ |
|---|---|---|---|---|
| 上游 `default_secret_patterns.json` | **10** | ❌ | ❌ | ❌ |
| 本插件 `engine.js:237 DEFAULT_SECRET_PATTERNS` | **17** | ✅ `**/.env` `**/.env.*` | ✅ | ✅ |

上游只认 `.ssh/**`、`id_rsa|dsa|ecdsa|ed25519`、`.netrc`、`_netrc`、`.npmrc`、`.pypirc`、`.dockercfg`。
**本插件额外把 `.env`、`*.pem`、`*.key`、`*.p12`、`credentials`、`credentials.json`、
`secrets.yml|yaml`、`.aws/credentials`、`.config/gcloud/**`、`.kube/config` 当作凭据。**

方向同样是「更保守」：fixture `all-gated-out` 里的 `config/.env` 在本插件被 `secret` 谓词
拦下，**在上游会走到第 5 步**（`.env` 在支持的扩展名表里）**并被放行**。
→ 这是本插件与上游**结果不同**的第一处：同一份 diff，`config/.env` 上游会进审查，
本插件不会。我认为这处差异是本插件更正确的一侧，但它确实是差异，不是「移植」。

---

## 5. 默认排除：**完全对齐**

上游 `default_exclude_patterns.json` 与本插件 `engine.js:213 DEFAULT_EXCLUDE_PATTERNS`
逐条比对，20 条**完全一致**：

```
**/node_modules/**  **/vendor/**  **/dist/**  **/build/**  **/out/**  **/target/**
**/.git/**  **/__pycache__/**  **/.venv/**  **/venv/**  **/coverage/**
**/*.min.js  **/*.min.css  **/*.map  **/*.lock  **/package-lock.json
**/pnpm-lock.yaml  **/yarn.lock  **/go.sum  **/Cargo.lock
```

---

## 6. 尺寸闸门：**量纲不同，不可直接比较**

| | 上游 | 本插件 |
|---|---|---|
| 度量 | `llm.CountTokens(diff)`，真实 BPE 分词 | `c.bytes`，源侧给的字节数 |
| 阈值 | `llmpool.PromptTokenLimit(args.Template.MaxTokens)`；`MaxTokens=0` 时**整个闸门关闭** | `ctx.maxFileBytes`，默认 `1_048_576`（`index.js:79`） |
| 位置 | `selectFiles`，静态闸门之后 | 谓词表最后一位 |

**这是量纲差异，不是阈值差异**，不能折算成「谁更严」。
另外本插件的 `bytes` 由 P0 给出（`source.js` 用 hunk 摘录的字节数），
而上游量的是整个文件的 diff 文本——本插件的候选粒度是 hunk，量它自己的摘录才是对的。

**本次实现没有触碰到 `too-large` 谓词**：`domains/code-review/index.js` 没有声明
`maxFileBytes`，所以它取引擎默认值。fixture 也不通过它构造边界（`all-gated-out` 靠
`binary/secret/deleted/extension/default-path/user-exclude` 六条），避免了一个
13MB 的假 fixture。`test.mjs` 里有一条**显式**的 `too-large` 单测，用
`gate(..., { maxFileBytes: 1024 })` 直接压下阈值——这是唯一诚实的做法：与其造一个
巨大的 fixture，不如把阈值调小。

---

## 7. P2 分捆：**两侧的策略空间不同，本插件的 code-review 只用了其中一种**

上游 `internal/agent/grouping.go:68 groupDiffs`：

```
len(diffs) <= 1                  -> 每文件一组（无条件短路）
GroupingPlan(files, churn) != LLM -> 本地决策（GroupingBundleAll 或 per-file）
否则                              -> 调 LLM 做语义分组，失败回落每文件一组
```

本插件 `lib/engine.js:398 bundle`：

```
len(entries) <= 1        -> short-circuit-single
len(entries) < minFiles  -> short-circuit-small（整个变更集一捆）
否则                     -> 按 entry.key 分组（key 由 pack.bundleKey 派生）
```

**关键差异**：上游在超过阈值时把「怎么分组」交给模型；本插件在超过阈值时**按确定性的
key 分组**，key 来自 pack 声明的 `bundleKey: { strategy: 'directory', depth: 1 }`。

这是本次迁移**有意做的选择**：`bundleKey` 是 t1/t2 明确要求「真正参与分捆」的字段，
把它接到模型调用上就等于让它在有模型时可用、无模型时失效。
代价是：上游那种「按语义分组」（把 `src/util/*` 和 `src/app.ts` 归到一起是因为它们相关，
而不是因为路径同前缀）本插件做不到。**这是能力差异，不是等价实现。**

`minFiles = 4` 与上游的 `GroupingMinFiles` 默认值是否相同：**未验证**——
`GroupingMinFiles` 来自 `template.Template`，我没有追到它的默认值定义，
所以不写结论。

---

## 8. P5 锚点：**移植，且刻意砍掉了上游的一层**

上游 `internal/diff/resolver.go`：`normalizeLine`（:301）、`matchConsecutive`（:217），
本插件 `engine.js:32/59` 逐条移植，注释里标了上游行号。

**差异在于降级阶梯的层数**：

| | 上游 | 本插件 |
|---|---|---|
| tier 1 | 在模型声明的文件里命中 | 同 |
| tier 2 | 跨文件**唯一**命中则搬迁（`RelocateAcrossFiles`） | 同 |
| tier 3 | **第四级：再调一次 LLM 重新定位** | **没有这一级** |
| 终态 | 未锚定 | 未锚定 + `locator-mismatch`（行号与原文矛盾）/`relocation-ambiguous`（位置不唯一） |

`engine.js:105` 的注释写明了为什么砍掉第四级：模型猜出来的位置不是引擎能复核的位置，
而这一层的全部意义就是「引擎能独立重算每一条发现」。
本插件额外拆出 `locator-mismatch` 与 `relocation-ambiguous` 两个终态——上游把这两种情况
一并归为「没找到」，本插件要求它们各自可辨认，因为它们对应的补救动作不同：
前者要模型重抄原文，后者要么补行号、要么人工看。

---

## 9. 结论：做到哪一步，没做到什么

**做到了（静态可核）**
- 闸门谓词的**顺序与语义**逐条对照完毕，含两处差异与一处刻意对齐。
- 默认排除模式 20 条**逐条一致**。
- 支持的扩展名、凭据路径两处**量化差异**已给出（本插件准入集合是上游的子集，凭据名单更宽）。
- P2 分组策略的**结构性差异**（确定性 vs LLM）已说明。
- P5 锚点移植来源（上游文件名 + 行号）与**刻意砍掉的一级**已说明。

**没做到（不要把它们当成已完成）**
- **上游二进制未构建**：本机无 `go`。因此 `ocr delegate preview` 的**运行输出不存在**，
  本文没有任何一张「同一份 fixture，两侧逐文件对照」的表——那种表需要跑起来才能给。
- **没有对同一份 fixture 做运行期对照。** 我能做的是把我的 `source.js` + `gate()` 对
  fixture 的输出列出来（见 `test.mjs` 的断言），把上游的**应有**输出从源码推出来，
  但推出来的不是观测值。要补这一张表，需要一台能 `make build` 的机器。
- **`GroupingMinFiles` 的默认值未追到**，因此第 7 节没有下「阈值是否一致」的结论。
- **上游的 hunk 解析在跨文件边界上的行为**（`hunk.go` 里 "Stop processing if we hit
  another file's diff header"）只确认存在，没有逐行比对我的 `parseUnifiedDiff` 的对应分支。

**下一步能补上运行期对照的最小动作**：在装有 Go 1.25 的机器上

```bash
cd open-code-review && make build
./bin/ocr delegate preview --from <base> --to <head> --json > upstream.json
# 同一份 diff 喂给本插件
node -e "…source.enumerate + engine.gate…" > downstream.json
# 逐文件比对 {path, will_review|admitted, exclude_reason|predicate}
```

三处预期会出现的差异（本文已先行给出，供对照时核对）：
`config/.env`（本插件 `secret`，上游放行）、
`style.css` / `src/schema.json`（上游放行，本插件 `extension`）、
以及分组数量（上游可能交 LLM，本插件按目录）。
