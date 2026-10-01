---
name: verbatim-only
match:
  - sessions/**
needs-expert-review: true
title: 原话优先
severity: high
source: agent-drafted (t8); 尚无专家背书
---
每条需求必须能追溯到语料里逐字出现的原话，并给出场次与句号。

失败模式：把「用户说 A」升格为「用户需要 B」，而 B 在语料里从未出现。升格后的需求看起来更专业，因此最难被发现。

取证义务：附上原话与 sessions/<id>/u<n>；引擎会用滑窗独立重算，转述一律判未锚定。

不算：访问记录、工单标题、二手转述都不是原话。没有原话支撑的条目进「无来源」列表，不进结论。
