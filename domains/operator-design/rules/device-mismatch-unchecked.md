---
name: device-mismatch-unchecked
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
title: 设备不一致未校验
source: agent-drafted
---
输入张量落在不同设备/内存空间上时，算子没有校验就直接访问，导致非法访问或错误结果。
必须指出缺失的校验点。
不算：框架保证同设备的内部调用路径，且该保证有断言。
