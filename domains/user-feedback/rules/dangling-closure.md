---
name: dangling-closure
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: critical
source: agent-drafted
---

悬空闭环：反馈的 `closedBy` 指向一个在 `decisions` 里根本不存在的 ID。这条反馈看起来已经关闭，实际关闭它的东西不存在。取证义务：给出反馈 ID、它声明的 `closedBy` 值，以及台账里 `decisions` 的全部 ID。不算：`closedBy` 指向的决策存在、只是没在 `addresses` 里提起这条反馈 —— 那是单边闭环，不是悬空。
