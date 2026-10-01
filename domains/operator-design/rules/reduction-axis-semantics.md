---
name: reduction-axis-semantics
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
title: 归约轴语义与声明不一致
source: agent-drafted
---
实现对 `axis`/`dim`/`keepdim` 的处理与文档不符（负轴、越界轴、多轴组合）。
必须给出一个具体轴参数与期望结果。
不算：文档显式声明不支持负轴且对负轴抛错（此种应确认抛错确实发生）。
