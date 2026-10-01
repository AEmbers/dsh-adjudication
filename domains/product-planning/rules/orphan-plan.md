---
name: orphan-plan
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 方案侧孤儿
severity: high
source: agent-drafted (t8); 尚无专家背书
---
不承接任何需求的方案项必须列为发现。

失败模式：顺手做的重构、老板提的想法，混在方案里占用了本季度的容量。

取证义务：说明它是没有需求来源，还是需求尚未登记。

不算：技术债治理若确有需求条目（内部需求也算），不构成孤儿 —— 但需求必须存在。
