---
name: rollout-and-rollback
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 发布与回滚
severity: high
source: agent-drafted (t8); 尚无专家背书
---
方案必须说明如何发布、失败时如何回滚。

失败模式：上线即全量，出问题只能回滚数据库。

取证义务：给出灰度范围与回滚触发条件。

不算：无状态、可秒级回滚的改动可以简化描述，但要说明为什么简单。
