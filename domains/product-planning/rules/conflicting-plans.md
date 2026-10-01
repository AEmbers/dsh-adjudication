---
name: conflicting-plans
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 方案冲突
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
两个方案对同一条需求给出不同做法时，必须并列写出冲突点。

失败模式：两份方案各自成立，合起来互相拆台。

取证义务：指出冲突的需求 ID 与两种做法的差异。

不算：一个是另一个的前置阶段时不构成冲突，但要说清先后。
