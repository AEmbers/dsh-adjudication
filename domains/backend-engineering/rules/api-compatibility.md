---
name: api-compatibility
match:
  - **/*.proto
  - **/*.ts
  - **/*.go
  - **/*.java
  - **/*.yaml
needs-expert-review: true
title: 接口兼容
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
字段/参数/返回值的增删改是否破坏已有调用方；必填性变化尤其危险（可选字段变必填是最常见的事故）。

失败模式：把新增必填字段当成兼容变更发布，所有老客户端在下一次请求时 400。

取证义务：指出受影响的具体调用方（仓库内路径或 API 消费者），否则不算证明。

不算：内部私有接口仍按公开接口对待，除非有证据表明它只有一个调用方且同批发布。
