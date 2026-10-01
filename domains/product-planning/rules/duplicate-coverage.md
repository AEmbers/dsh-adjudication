---
name: duplicate-coverage
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 重复覆盖
severity: low
source: agent-drafted (t8); 尚无专家背书
---
多条方案承接同一条需求时，说明分工而不是重复。

失败模式：同一条需求被三个方案各做一遍，谁都没做全。

取证义务：说明每条方案覆盖需求的哪一部分。

不算：刻意的多方案 A/B 试验要标为试验。
