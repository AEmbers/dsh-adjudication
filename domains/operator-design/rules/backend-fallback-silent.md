---
name: backend-fallback-silent
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
title: 后端不可用时静默回退
source: agent-drafted
---
加速后端因不可用/不支持而回退到参考实现时没有任何可观测信号（日志、警告、标志位），性能问题被掩盖。
必须指出回退点。
不算：文档明确了回退契约、且回退会写入可观测字段的场景。
