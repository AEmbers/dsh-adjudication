---
name: boundary-contract
match:
  - "**/*"
needs-expert-review: true
severity: high
source: agent-drafted
---

边界与契约：空值与零值、越界与截断、整数溢出、时区与编码、浮点精度、以及 API 契约的破坏性变更（字段重命名、语义改变、默认值改变）。
不算：内部私有函数的参数校验缺失（除非它是唯一的入口或变更直接引入了调用方）。
