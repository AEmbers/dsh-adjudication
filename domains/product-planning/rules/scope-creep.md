---
name: scope-creep
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 范围蔓延
severity: high
source: agent-drafted (t8); 尚无专家背书
---
方案中「顺手做」的附加项要单独列出，不得混在承接需求里。

失败模式：一个为了需求 A 的方案，悄悄带上了 B、C、D。

取证义务：逐项列出无需求来源的子项与它们预估的成本。

不算：为满足需求 A 而必须做的必要前置不算蔓延，但要写明它为什么必要。
