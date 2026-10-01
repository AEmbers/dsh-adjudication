---
name: traceability
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 可追溯性
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
每条方案项必须挂到至少一条**需求库中已确认**的需求，并给出需求 ID 与逐字原文。

失败模式：功能先做、需求后补；补出来的需求是为了让方案看起来有来源。

取证义务：需求 ID 必须在库里，原文逐字对得上；说不出来源的功能不进方案。

不算：需求未被确认（proposed/rejected）时，承接它的方案项不成立 —— 但那条需求本身仍在候选集里，不因未确认而被忘掉。
