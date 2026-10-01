---
name: fused-op-not-equivalent
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
title: 融合算子与分解实现不等价
source: agent-drafted
---
融合实现在某些参数下与逐算子组合的结果不一致（舍入顺序、中间精度、边界舍入）。
必须给出暴露差异的参数与两种结果。
不算：文档声明为近似融合并给出误差界的场景。
