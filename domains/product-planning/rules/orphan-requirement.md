---
name: orphan-requirement
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 需求侧孤儿
severity: high
source: agent-drafted (t8); 尚无专家背书
---
没有任何方案承接的已确认需求必须列为发现。

失败模式：需求评审通过了，路线图里没人接，半年后无人记得。

取证义务：给出需求 ID 与最后讨论时间；确认它是漏排还是有意推迟。

不算：明确标注「本期不做」并写下原因的需求不算孤儿，算已决。
