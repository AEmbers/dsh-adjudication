---
name: one-sided-closure
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

单边闭环：决策的 `addresses` 里写了这条反馈，但反馈自己的 `closedBy` 不是它（或根本没写）。闭环被宣布了，但没有被对方确认。取证义务：给出反馈 ID、决策 ID，以及两侧声明各自的实际取值（`addresses` 有/无、`closedBy` 指向谁）。不算：两侧都写了但指向不同的决策 —— 那是「指向冲突」，比单边更严重，单独成条。
