---
name: lineage-edge-declared-not-real
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

血缘边声明与图不符：节点声称的 inputs/outputs 与它 SQL 里真正读写的表不一致（多声明、少声明、写成了另一张表）。
失败模式：下游据此认为某张表已产出，实际从未被写入；或某张被读的表没有出现在 inputs 里，删除时无人知道它在被消费。
取证义务：必须同时给出节点 id、声明的 from -> to，以及你依据的那一行 SQL 原文；并说明图上这条边**不存在**（引擎会在血缘 JSON 里重算并拒绝）。
不算：只说「看起来不一致」不算；在图上确实存在的边不算；你读到的表名出现在注释或字符串字面量里、而图上确实有这条边，也不算缺陷。
