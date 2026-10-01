---
name: closure-without-status
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

闭环与状态矛盾：`closedBy` 已经指向某个决策，但反馈自己的 `status` 还是 `open`/`new`/`triage`。同一条记录里两个字段互相打脸。取证义务：给出反馈 ID、`status` 的实际取值、`closedBy` 的实际取值。不算：状态是 `in-progress` 且决策状态也是 `in-progress` —— 那两侧一致地表示未完成，`closedBy` 应改名为期待中的决策，单独成条。
