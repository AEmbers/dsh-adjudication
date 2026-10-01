---
name: non-goals
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 非目标
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
方案必须写清它**不做**什么。

失败模式：不做的事没有边界，评审时每人按自己的理解补需求。

取证义务：列出至少一条明确的非目标。

不算：非目标不能用来偷偷排除已被确认的需求。
