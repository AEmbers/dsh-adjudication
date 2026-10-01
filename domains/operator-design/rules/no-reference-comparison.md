---
name: no-reference-comparison
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
title: 缺参考实现对拍
source: agent-drafted
---
数值测试只断言「输出 shape 正确」或「有限」，从不与独立参考实现（朴素实现/另一后端/解析解）对比。
必须指出应当与什么对拍。
不算：纯 shape 推导类算子（无数学语义）。
