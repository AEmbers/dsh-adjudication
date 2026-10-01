---
name: unknown-dependency-target
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

未登记的依赖目标：dependsOn 里出现的 ID 既不在 tasks[] 也不在 idSpace[]。它可能是笔误（T-12 vs T12），也可能是被删掉的前置任务 —— 两种都必须暴露，因为计划里写着「等它」，而没有任何东西记录它是什么。取证义务：列出该 ID 与引用它的任务。不算：已在 idSpace 中声明的外部交付物。

