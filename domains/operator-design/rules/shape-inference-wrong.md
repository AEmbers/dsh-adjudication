---
name: shape-inference-wrong
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
title: shape 推导错误
source: agent-drafted
---
输出 shape 的推导规则在某种输入组合下与声明不同（padding、dilation、group、上采样因子）。
必须给出该输入组合与两种推导结果。
不算：输出 shape 由运行时动态决定、且已由框架统一校验的场景。
