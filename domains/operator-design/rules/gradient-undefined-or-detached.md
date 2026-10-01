---
name: gradient-undefined-or-detached
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
title: 反向传播定义缺失或断链
source: agent-drafted
---
算子声明可微，但反向实现缺失、被 `detach`/`no_grad` 截断，或对某些入参不产生梯度。
必须指出断链的位置。
不算：文档声明为不可微的前处理算子。
