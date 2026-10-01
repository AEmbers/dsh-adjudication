---
name: non-idempotent-insert
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

不可重跑：insert into 目标表而没有先 delete/merge/分区覆盖，重跑即翻倍。
失败模式：调度器一次重试让指标翻倍，且没有任何报错，一周后才发现。
取证义务：给出 insert 那一行原文与目标表名，并说明该表上没有分区覆盖或唯一约束（schema 中的约束缺失也要给出）。
不算：目标是 append-only 的事件表（重复事件本身有业务含义，必须引用说明）不算；上游已保证 exactly-once 且有据可查的不算。
