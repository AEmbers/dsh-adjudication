---
name: error-tolerance-at-exactly-zero
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
title: 恰好为 0 的中间量未处理
source: agent-drafted
---
归一化/相似度/对数类算子在中间量为 0 时未做 epsilon 处理，输出 -inf 或 NaN，而测试从未构造该输入。
必须指出该中间量与缺失的 epsilon。
不算：数学上不可能为 0 且已有断言保证的中间量。
