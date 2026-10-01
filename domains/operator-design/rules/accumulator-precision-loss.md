---
name: accumulator-precision-loss
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
severity: medium
title: 累加器精度不足
source: agent-drafted
---
归约、卷积、求和类算子的累加器使用了低于输入精度的类型（fp16 累加 bf16 输入），结果随规模漂移。
必须指出累加器类型与输入类型。
不算：文档声明为「近似实现」并给出误差界的算子。
