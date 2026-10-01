---
name: declared-metric
match:
  - plans/*/serves/**
needs-expert-review: true
title: 指标须被声明
severity: high
source: agent-drafted (t8); 尚无专家背书
---
方案引用的指标名必须由该方案自己声明，不能借用别的方案的指标。

失败模式：把公司级指标写进自己的方案，看起来贡献很大，实际无人负责。

取证义务：指标名必须出现在该方案的指标声明里。

不算：指标由更上层 OKR 下传时，写明下传关系即可。
