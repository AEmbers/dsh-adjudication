---
name: metric-gaming
match:
  - plans/*/serves/**
needs-expert-review: true
title: 指标可被游戏化
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
检查指标是否可被低成本地「做出来」而问题并未解决。

失败模式：把「工单关闭率」作为目标，于是工单被快速关闭而问题依旧。

取证义务：给出一条该指标的作弊路径，并说明为什么当前的指标不易被作弊。

不算：过程指标可以存在，但不能单独作为成败判据。
