---
name: risk-trigger-observable
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

触发条件不可观测：trigger 写成「如果进度紧张」这类无法判断真假的描述。不可观测的触发条件永远不会被触发，因此风险永远不会被升级。取证义务：指出该 trigger 缺少可观测信号（指标、事件、日期）。不算：trigger 引用了一个已登记的外部事件 ID。

