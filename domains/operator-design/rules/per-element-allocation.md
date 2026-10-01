---
name: per-element-allocation
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
title: 逐元素分配导致性能塌陷
source: agent-drafted
---
在热路径里为每个元素/每次迭代分配内存或构造对象。
必须指出分配点与它所在的循环。
不算：初始化阶段的一次性分配。
