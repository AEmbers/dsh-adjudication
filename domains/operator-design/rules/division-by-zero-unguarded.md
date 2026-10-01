---
name: division-by-zero-unguarded
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
title: 除零/归一化零分母未防护
source: agent-drafted
---
归一化、softmax、除法类算子在分母为 0 或全零时没有 epsilon 或分支处理。
必须指出分母来源与缺失的防护。
不算：文档声明为「未定义行为」且调用方契约要求输入非零的场景。
