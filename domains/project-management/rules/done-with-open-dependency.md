---
name: done-with-open-dependency
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

已完成但有未完成前置：任务状态为 done，而它的某条 dependsOn 指向状态为 todo/doing/blocked 的任务。这在图上是不可能的，只有两种解释：状态被误改，或前置任务被悄悄跳过。给出两边任务 ID。不算：前置任务是外部 ID 且已交付（需在 idSpace 里说明）。

