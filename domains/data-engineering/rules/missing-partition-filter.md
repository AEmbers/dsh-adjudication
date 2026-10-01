---
name: missing-partition-filter
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

缺少分区裁剪：查询没有按分区键过滤，扫描量与成本随历史增长。
失败模式：单次查询从秒级退化到小时级，账单增长先于告警出现。
取证义务：给出该表的分区键（来自 schema 或 DDL 原文），以及缺失过滤的那一行 FROM/WHERE 原文。
不算：小维表（有行数证据）不算；分区键未知/无分区设计的表不算本规则，属于 modeling 问题。
