---
name: dead-end-branch
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

死路分支：某条分支的最后一个步骤没有任何出路（next/onError/onCancel 全为空，也没有结束语义）。
取证义务：给出该分支的 id 与它最后一个步骤的声明。
不算：明确的终态页（成功页、完成页），它有结束语义。
