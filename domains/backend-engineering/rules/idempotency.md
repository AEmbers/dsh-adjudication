---
name: idempotency
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
  - **/*.sql
needs-expert-review: true
title: 幂等性
severity: high
source: agent-drafted (t8); 尚无专家背书
---
会被重试的写操作必须幂等（幂等键、唯一约束、或状态机）。

失败模式：支付重试导致重复扣款。

取证义务：给出幂等键或唯一约束的位置。

不算：由上游保证只调用一次的说法不算保证，除非给出上游的实现依据。
