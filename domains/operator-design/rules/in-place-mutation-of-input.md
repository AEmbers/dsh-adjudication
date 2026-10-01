---
name: in-place-mutation-of-input
match:
  - "**/*.py"
  - "**/*.cc"
  - "**/*.cpp"
  - "**/*.cu"
  - "**/*.cuh"
  - "**/*.h"
  - "**/*.hpp"
  - "**/*.c"
  - "**/*.rs"
  - "**/*.go"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.ml"
  - "**/*.swift"
  - "**/*.ts"
  - "**/*.js"
needs-expert-review: true
severity: high
title: 原地修改调用方输入
source: agent-drafted
---
算子在没有文档说明的情况下就地改写输入缓冲，调用方后续使用该张量时拿到被污染的数据。
必须指出被改写的缓冲与写入点。
不算：文档/接口名明确声明为 in-place 的变体（如 `_` 后缀）。
