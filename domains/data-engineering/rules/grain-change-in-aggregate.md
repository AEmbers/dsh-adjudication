---
name: grain-change-in-aggregate
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

聚合粒度改变：group by 增删了一个键，指标含义随之改变但列名没变。
失败模式：同一列在不同时期有不同粒度，报表对比悄悄失真。
取证义务：给出 group by 那一行原文，并给出消费该表的下游是如何按旧粒度使用的（可抄写的原文）。
不算：新增列而非改变粒度不算；下游同步变更且已发布不算（需给出证据）。
