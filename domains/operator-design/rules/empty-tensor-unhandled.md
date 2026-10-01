---
name: empty-tensor-unhandled
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
title: 空张量/零维未处理
source: agent-drafted
---
batch=0、序列长度为 0、含 0 的维度没有分支处理，落到除零或越界。
必须指出会触发的那条语句。
不算：契约规定非空且入口已有显式校验的场景。
