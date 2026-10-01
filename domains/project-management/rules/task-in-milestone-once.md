---
name: task-in-milestone-once
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: low
source: agent-drafted
---

里程碑归属：同一任务被多个里程碑声明时，要么是复用的检查点（合法），要么是归属重复（不合法）。给出任务 ID 与全部声明的里程碑。不算：任务出现在两个里程碑中且二者 due 相同 —— 那仍是重复归属。

