---
name: observability-on-failure
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 失败可观测
severity: high
source: agent-drafted (t8); 尚无专家背书
---
失败路径是否有日志/指标/追踪，且能让值班者定位到具体请求。

失败模式：接口 500 了，日志只有「internal error」，无法关联请求。

取证义务：指出日志字段与请求标识的传递路径。

不算：打印了但字段缺失（无 request id / 无错误原文）不算可观测。
