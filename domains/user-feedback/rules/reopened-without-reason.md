---
name: reopened-without-reason
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

重开无理由：反馈被重开（`status` 回到开启态，或 `reopened: true`），但没有任何字段说明为什么上一次关闭不成立。取证义务：给出反馈 ID、上一次的 `closedBy`、以及重开后的状态。不算：重开后立刻有了新的 `closedBy` 指向另一个决策并写了理由 —— 那是有记录的二次处理。
