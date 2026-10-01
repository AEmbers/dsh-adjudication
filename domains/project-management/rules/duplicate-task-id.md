---
name: duplicate-task-id
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

任务 ID 重复：同一 ID 在 tasks[] 中出现两次，或出现在两张图上。重复 ID 让「T1→T9 这条边」失去指向 —— 任何关于它的结论都无法被重算，因此这类缺陷优先级高于它引起的任何具体问题。取证义务：列出 ID 与全部声明位置。

