---
name: missing-not-null-default
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

新增非空列没有默认值或回填：DDL 与写入逻辑不一致。
失败模式：写入在运行期失败，或历史分区留空成为隐性 NULL。
取证义务：给出 DDL 那一行原文与写入语句中缺失该列的位置。
不算：可空列不算；有明确的 backfill 任务且已给出证据的不算。
