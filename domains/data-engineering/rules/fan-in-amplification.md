---
name: fan-in-amplification
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

扇入放大：一个节点读取多个大表并做多路 join，单次运行的代价是各输入之和的数倍。
失败模式：单点成为整个 DAG 的瓶颈，失败影响面最大。
取证义务：给出各输入表名与该节点的 join 原文，并给出各表规模证据。
不算：维表 join 不算；没有规模证据时只能标注为待度量。
