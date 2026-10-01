---
name: overflow-in-index-or-size-math
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
title: 索引/尺寸计算溢出
source: agent-drafted
---
用 32 位整数计算元素总数、偏移或步长乘积，在大 shape 下溢出为负值或截断。
必须指出该乘法/加法表达式。
不算：已用 64 位整数且上游有断言的位置。
