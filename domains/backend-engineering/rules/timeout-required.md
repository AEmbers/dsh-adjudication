---
name: timeout-required
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 超时必须显式
severity: high
source: agent-drafted (t8); 尚无专家背书
---
每个外部调用都要有超时；依赖默认值时必须写出默认值是多少。

失败模式：HTTP 客户端没有超时，慢下游把线程池占满。

取证义务：给出超时值的设置位置。

不算：框架默认超时存在时，仍要写出默认值，否则无法判断。
