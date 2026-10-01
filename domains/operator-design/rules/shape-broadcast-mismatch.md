---
name: shape-broadcast-mismatch
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
title: 广播语义与声明不符
source: agent-drafted
---
实现按某一轴广播，而文档/类型声明写的是另一套语义（或反之），导致某些 shape 组合静默得到错误结果。
必须给出一个会暴露差异的具体 shape 组合。
不算：文档声明为「与框架 X 的广播规则一致」且已有该框架的对拍测试。
