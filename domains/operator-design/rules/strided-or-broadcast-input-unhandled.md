---
name: strided-or-broadcast-input-unhandled
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
title: 跨步/广播输入未处理
source: agent-drafted
---
输入带非单位步长或该轴长度为 1 时，索引仍按单位步长计算。
必须指出索引算式。
不算：由上游算子保证输入已物化的内部辅助函数。
