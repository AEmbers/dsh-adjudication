---
name: dedup-without-key
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

去重没有稳定主键：用 row_number 按非确定性字段取首行，或 distinct 掉了业务上必须保留的重复。
失败模式：同一输入两次运行得到不同结果，无法复现。
取证义务：给出去重那一行原文与它使用的排序键，并说明为何该键不唯一或不稳定。
不算：业务上明确允许任选一行的场景不算（需引用那段说明）。
