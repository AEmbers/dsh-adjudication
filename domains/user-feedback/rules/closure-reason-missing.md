---
name: closure-reason-missing
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: medium
source: agent-drafted
---

闭环无理由：`closedBy` 有了，但 `closeReason` 缺失。闭环成立了，可为什么关掉这件事没有留下。取证义务：给出反馈 ID 与关联的决策 ID。不算：决策本身的 `rationale` 里明确写了为什么处理这条反馈 —— 那理由在决策侧，引用它即可，不必重复。
