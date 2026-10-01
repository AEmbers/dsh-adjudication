---
name: transaction-boundary
match:
  - **/*.go
  - **/*.java
  - **/*.py
  - **/*.ts
  - **/*.sql
needs-expert-review: true
title: 事务边界
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
一次业务写操作是否落在同一个事务里；事务边界是否与业务边界一致。

失败模式：先写订单再写订单项，第二步失败后留下孤儿订单。

取证义务：给出事务的开始与提交点，以及失败时的补偿。

不算：最终一致（有补偿与对账）是合法设计，但补偿必须存在且可观测。
