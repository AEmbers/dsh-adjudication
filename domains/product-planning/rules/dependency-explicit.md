---
name: dependency-explicit
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 依赖显式
severity: high
source: agent-drafted (t8); 尚无专家背书
---
方案的前置依赖必须列出，并标注依赖当前是否具备。

失败模式：依赖一个还没立项的系统，排期时才发现。

取证义务：逐条列出依赖项及其状态（已有/在建/未立项）。

不算：同团队内部的常规协作不必逐条列，跨团队/跨系统必须列。
