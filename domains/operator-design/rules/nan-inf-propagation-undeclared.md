---
name: nan-inf-propagation-undeclared
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
title: NaN/Inf 传播行为未声明未测试
source: agent-drafted
---
实现对 NaN/Inf 的处理（清成 0、跳过、传播、钳位）与文档/框架约定不一致，或压根没有测试。
必须指出该处理发生的位置。
不算：以数值稳定性为设计目标、且已在文档中写明钳位规则的算子。
