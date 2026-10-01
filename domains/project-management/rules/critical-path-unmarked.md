---
name: critical-path-unmarked
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

关键路径未标注：图上存在明显的最长依赖链，但计划没有标出它。交付日期由关键路径决定，未标出的关键路径意味着团队不知道自己在为哪条链加班。给出链上的任务 ID 序列。不算：任务数少于 4 的图（没有可辨别的关键路径）。

