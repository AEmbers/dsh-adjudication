---
name: estimate-vs-scope
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: high
source: agent-drafted
---

估算与范围匹配：任务描述所需的工作量与 estimateDays 是否量级一致。典型失败是「重写鉴权中间件」给 1 天，或把明确的未知项给了确定性估算。取证义务：引用任务说明里的原文片段，并说明量级差异依据。不算：只有标题、没有说明的任务（没有可比对的范围描述）。

