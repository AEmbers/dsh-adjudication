---
name: dtype-branch-missing
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
title: 某个 dtype 分支未实现
source: agent-drafted
---
算子声称支持若干 dtype，但实现对其中一种没有分支（落到默认路径后语义错误或直接抛错）。
必须指出缺失的 dtype 与它会走到的默认路径。
不算：文档明确声明不支持的 dtype（此种情况应走到显式的拒绝分支）。
