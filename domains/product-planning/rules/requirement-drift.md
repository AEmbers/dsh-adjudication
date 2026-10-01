---
name: requirement-drift
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 需求漂移
severity: high
source: agent-drafted (t8); 尚无专家背书
---
方案与需求原文出现偏差时，说明偏差是澄清还是替换。

失败模式：方案做的其实是另一件事，但继续沿用原需求 ID。

取证义务：对照需求逐字原文，指出偏差点。

不算：需求原文本身被更新时，按新原文重新对齐。
