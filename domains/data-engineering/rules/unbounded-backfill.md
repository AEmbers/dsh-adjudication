---
name: unbounded-backfill
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

无界回填：一次运行回填全部历史，没有分批、没有上限、没有中断点。
失败模式：占用集群数小时，失败后从头再来。
取证义务：给出回填范围表达式那一行原文，并说明它没有批次参数或上限。
不算：明确限定小范围（有日期上界证据）的不算。
