---
name: migration-safety
match:
  - "**/migrations/**"
  - "**/*.sql"
  - "**/migration*.js"
  - "**/migration*.ts"
  - "**/alembic/**"
needs-expert-review: true
severity: critical
source: agent-drafted
---

数据迁移安全：新增非空列是否有默认值或回填步骤、是否有锁表风险、是否可回滚、旧版本代码与新 schema 共存期间是否可用（前后兼容）。
必须说明迁移期间新旧代码同时在跑时会发生什么。
不算：纯索引或纯注释类变更。
