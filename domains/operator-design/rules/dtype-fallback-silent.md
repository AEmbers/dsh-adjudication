---
name: dtype-fallback-silent
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
title: 不支持的 dtype 静默降级
source: agent-drafted
---
遇到未支持的 dtype/后端时静默转换成另一种类型继续算，调用方不知情地拿到低精度或错误语义的结果。
必须指出降级发生的代码位置与目标类型。
不算：文档声明的自动提升（promotion）语义，且提升规则有测试覆盖。
