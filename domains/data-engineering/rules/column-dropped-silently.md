---
name: column-dropped-silently
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

字段被静默丢弃：新链路没有 select 某个下游仍在使用的字段，且没有任何告警或迁移说明。
失败模式：下游读到全 NULL 或直接报错，而变更的评审里看不出这件事。
取证义务：给出被丢弃的字段名、它原来所在的表，以及新链路 select 列表的那一行原文。
不算：字段仍在但被别名映射（引用别名那一行则保留，不算丢弃）不算；下游已经不再引用该字段（需给出证据）不算。
