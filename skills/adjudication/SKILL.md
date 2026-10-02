---
name: adjudication
description: 用 dsh-adjudication 插件对一段工作做「有锚点、可独立复核」的审定（代码评审 / 风控合规 / 需求调研 / 产品规划 / UX / UI / 架构 / 后端 / 前端 / 数据工程 / 算法模型 / 技术测试 / 技术文档 / 算子设计 / 逆向工程 / 项目管理 / 用户反馈 / 需求对齐 / 市场调研）。当用户输入 /adjudication，或说「审一下」「帮我把关」「有没有问题」「漏了什么」而没有指明领域时使用。**用户通常不知道自己的工作属于哪个领域，甚至可能同时属于好几个 —— 不要问，自己路由。**
---

# 审定 adjudication

要审的东西：$ARGUMENTS

## 你的第一件事是路由，不是提问

用户说不出领域名是常态（一段工作可能既是代码、又是算子、又牵涉文档）。**不要反问「这属于哪个领域」** —— 用工具自己算出来。

1. **先看实物**。你手上通常有比用户的话更有信息量的东西：改动的文件、diff、文档、目录树、issue 文本。把这些文件路径收集起来。
2. **一次调用同时传原话与路径**：

   ```
   adjudication_domains({
     query: "<用户的原话，一整句也可以>",
     paths: ["src/config.ts", "pkg/queue/worker.go", ".sql"]   // 实物路径或扩展名
   })
   ```

   它按碎片打分，**返回多个**可能相关的领域、按相关度排序、每条带「命中理由」。**命中多个是预期结果，不是噪声。**
3. **拿不准就再来一次**：换关键词、或只传 `category`（A 审定型 / B 构建型 / C 探索型 / D 关系型）看整族。
4. **空结果不是终点**。**不管工具有没有给你下一步提示，这条都成立**：`query` 返回 0 条时，就**不带参数**再调一次 `adjudication_domains`，把 19 个领域的「标题 + 一句话摘要 + 锚点 + 损失取向」读一遍，**自己判断**该用哪几个。**永远不要回答用户「没有对应的领域」** —— 那只会意味着你路由失败了，而这个插件存在的理由正是替用户做完这一步。

   > 老版本（`70351db` 之前）的检索是整串子串匹配，一整句话会返回 0。**新版按碎片打分，一句话会返回多个领域并带理由。** 无论跑在哪个版本上，回到全量清单自己判断都是可靠的兜底。

## 然后逐域跑 P0→P7

对每个入选领域（**通常 2–4 个**）：

```
adjudication_activate({ domain: "<id>", depth: "full" })     // 装上它自己的工具
adjudicate_<id>_plan({ target: "...", input: {...} })        // P0–P3：候选 → 闸门 → 分捆 → 注入规则
```

- **`plan` 的输出就是你的工作单**：`admitted` 是准入的候选，`bundles` 是分捆，每捆里列出**本捆注入的规则名**。先读规则，再逐捆做判断。
- 需要原文时用该域的 `_evidence_*` 工具（有界：行数/条数/调用次数都有上限，超了会被引擎拒绝）。
- 每条发现**必须**给锚点：

  ```
  adjudication_anchor({ domain, path, locator, excerpt, documents: [{path, content}] })
  ```

  **`excerpt` 必须逐字抄原文。** 引擎会拿它去对文档 —— 转述、概括、改写一律判 `unanchored`，这是设计，不是 bug。
- 最后交回：

  ```
  adjudication_submit({ domain, findings, documents, candidates?, total? })
  ```

  引擎会重算锚点、跑 **P6 独立复核**、按该域的**损失取向**取舍、并出**覆盖率证明**。
- 用完 `adjudication_deactivate({ domain })` 卸载，别让工具面一直占着上下文。

## 报告要这么写

1. **先说路由结果**：选了哪几个领域、**为什么**（引用工具给的「命中理由」，加上你自己的判断）。用户最需要知道的就是这一步。
2. **再给结论**：按领域分段。每条发现给 `文件:行`，并标注它的锚定状态（`anchored` / `unanchored`）。
3. **必须给覆盖率**：`submit` 返回的 coverage 是硬数字。**precision-first 的域覆盖率不达标会被判不完整；recall-first 的域宁可保留存疑项。** 不要只报告「找到了什么」，要报告「审了多少、还有多少没审」。
4. **`unanchored` 的发现要单独列**，并说明「锚不上」不等于「不存在」，只等于「没有被确认」。
5. 若 P6 报了 `E_VERDICT_UNPARSED` 或 `ran:false`，**照实说复核没跑成**，不要把「没有要推翻的」和「复核没跑」混为一谈。

## 边界（必须向用户交代）

- 插件里的领域规则（约 460 条）**由 agent 起草、全部标 `needs-expert-review: true`、未经领域专家审定**。引擎的闸门、锚点、分捆、覆盖率、独立复核是完整且被断言的；**规则在专业上对不对不在断言能覆盖的范围里**。
- 采集型（C 探索型：市场调研、逆向工程）**候选集不可先验枚举、成本无上界**，这一点每次都会写进结果。

## 参考文档（需要细节时读）

- `C:\Sophia\dev-plugin\dsh-adjudication\README.md` —— 19 个领域的总表与用法
- `C:\Sophia\dev-plugin\dsh-adjudication\docs\domain-contract-v2.md` —— 每个领域的**输入格式**与锚点定义（喂错格式会被闸门拒绝）
- `C:\Sophia\dev-plugin\dsh-adjudication\docs\adding-a-domain.md` —— 第 20 个领域怎么写
- `C:\Sophia\dev-plugin\dsh-adjudication\docs\review-antipatterns.md` —— 写/审断言前先读
