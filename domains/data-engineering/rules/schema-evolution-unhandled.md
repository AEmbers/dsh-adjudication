---
name: schema-evolution-unhandled
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

上游 schema 演进未处理：新增/重命名列后下游按位置取值（select *、按序解包）。
失败模式：列顺序变化导致数据整体错位，无报错。
取证义务：给出 select * 或按位置解包的那一行原文，并给出上游 schema 中新增列的证据。
不算：明确引用列名的不算。
