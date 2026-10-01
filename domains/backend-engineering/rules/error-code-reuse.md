---
name: error-code-reuse
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 错误码复用
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
返回给调用方的错误码/错误类型应当复用既有语义，而不是为同一情况新增一个。

失败模式：同一失败路径出现三种错误码，监控告警无法聚合。

取证义务：给出既有错误码与新增错误码的语义差异。

不算：确实需要区分的子类可以新增，但要说明为什么既有码不足以区分。
