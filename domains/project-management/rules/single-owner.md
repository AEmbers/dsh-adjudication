---
name: single-owner
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

责任唯一：每个任务是否有且仅有一个负责人。没有负责人的任务在计划里是「有人会做」的幻觉；有多个负责人的任务在出事时无人负责。两者都要给出任务 ID。不算：owner 字段写了团队名而团队在 teams[] 里唯一确定 —— 那仍是一个责任主体，但要在报告里说明是团队级。

