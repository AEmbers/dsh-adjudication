---
name: non-contiguous-input-unhandled
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
title: 非连续内存输入未处理
source: agent-drafted
---
实现假定输入连续（`data_ptr` + 线性索引），对转置/切片产生的非连续视图会算出错误结果或越界。
必须指出做出该假定的索引计算位置。
不算：入口显式做了 `contiguous()` 的地方（但要确认它确实在校验之前执行）。
