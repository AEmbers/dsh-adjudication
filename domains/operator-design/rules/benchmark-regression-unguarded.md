---
name: benchmark-regression-unguarded
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
severity: low
title: 性能回归无守护
source: agent-drafted
---
仓库有基准但 CI 不设阈值也不做历史对比，性能可以任意劣化。
必须指出应设阈值的基准项。
不算：基准与 CI 门禁在别处（外部性能平台）且配置可见。
