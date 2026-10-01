---
name: streaming-state-not-reset
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
title: 流式/分块状态未重置
source: agent-drafted
---
算子在分块调用之间保留状态，重新开始一次推理时没有重置入口，第二次结果受第一次影响。
必须指出未重置的状态字段。
不算：状态由调用方通过显式句柄管理、且接口名表达了这一点（如 `init_state`）。
