---
name: measurable
match:
  - plans/*/serves/**
needs-expert-review: true
title: 可度量
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
目标必须有指标名、基线、目标值、时间窗。四者缺一，目标不成立。

失败模式：「提升转化率」没有基线、没有目标值、没有时间窗，年底无法判断成败。

取证义务：给出四项具体取值；基线必须来自已有测量而非估计（估计要标注）。

不算：定性目标（如「完成迁移」）可以不用百分比，但必须有完成判据。
