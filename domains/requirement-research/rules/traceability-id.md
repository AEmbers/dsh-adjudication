---
name: traceability-id
match:
  - sessions/**
needs-expert-review: true
title: 可追溯 ID
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
每条需求给出 sourceQuoteId（sessions/<id>/u<n>），并保证它指向真实存在的句子。

失败模式：ID 写错一位，追溯链断掉，后续无法复核。

取证义务：ID 必须能被引擎重算命中；generator.js 的 unsourced 列表就是这条规则的执行结果。

不算：指向场次而非句号不算可追溯。
