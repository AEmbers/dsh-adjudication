---
name: risk-register
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 风险登记
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
每条方案至少给出一条「什么情况下这个方案会失败」。

失败模式：风险一栏写「进度风险」这类无法行动的句子。

取证义务：风险必须可触发、可观察，并附一条应对。

不算：无法应对的风险也要写，标注为「接受」。
