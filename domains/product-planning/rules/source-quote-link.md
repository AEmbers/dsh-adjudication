---
name: source-quote-link
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 回链原话
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
需求条目应带上 sourceQuoteId，指向它来自的那句原话。

失败模式：需求与调研脱钩，半年后无人知道它为什么存在。

取证义务：给出 sourceQuoteId；缺失时标注为「来源待补」。

不算：内部技术需求可以没有原话来源，但要写明提出人与场景。
