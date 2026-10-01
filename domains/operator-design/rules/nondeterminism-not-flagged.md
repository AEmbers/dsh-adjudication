---
name: nondeterminism-not-flagged
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
title: 非确定性未声明
source: agent-drafted
---
实现使用了 atomic 累加、并行规约乱序、随机采样，结果随运行不同，但既未声明也不提供确定性开关。
必须指出非确定性的来源。
不算：文档已声明非确定性并提供了确定性模式。
