---
name: target-vs-stretch
match:
  - plans/*/serves/**
needs-expert-review: true
title: 目标与期望分离
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
承诺目标与期望值（stretch）必须分开写。

失败模式：把期望值当作承诺，导致为了达标牺牲质量。

取证义务：分别给出承诺值与期望值。

不算：只有一条目标时不必伪造第二条。
