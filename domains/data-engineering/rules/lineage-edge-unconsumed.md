---
name: lineage-edge-unconsumed
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

产出无人消费：某张表被节点声明为 outputs，但全图没有任何节点把它列为 inputs。
失败模式：pipeline 每天在写一张没人读的表，成本持续发生而价值为零；真正的下游可能读的是旧表名。
取证义务：给出产出节点、表名，并给出「全图无消费者」这一事实（用 lineage_walk 从该表出发回到空集）。
不算：中间表被外部 BI 直接查询（无法从本图判断）不算缺陷，只能标注为待确认；一次性回填任务的临时表不算。
