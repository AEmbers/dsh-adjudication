---
name: owner-exists
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

负责人存在：任务 owner 是否能在 owners[] 里找到；找不到时该名字是离职、外包还是笔误。给出任务 ID 与未登记的 owner 名。不算：owner 写成团队名且该团队在 teams[] 中 —— 那不是未登记。

