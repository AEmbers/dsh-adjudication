---
name: gradient-numerical-check-missing
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
title: 反向缺数值梯度校验
source: agent-drafted
---
有反向实现但只对比了形状，没有与数值梯度（有限差分）对比。
必须指出应当做梯度校验的输入。
不算：解析导数已在别处被独立验证、且有引用链接的场景。
