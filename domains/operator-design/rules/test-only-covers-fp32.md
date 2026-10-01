---
name: test-only-covers-fp32
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
title: 数值测试只覆盖单一精度
source: agent-drafted
---
测试矩阵只跑了 fp32（或只跑默认 dtype），bf16/fp16/fp64 的精度与溢出行为完全未验证。
必须指出未覆盖的 dtype。
不算：文档明确只支持一种精度的算子。
