---
name: dependency-inversion-missing
match:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/*.py"
  - "**/*.rs"
  - "**/*.go"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.swift"
  - "**/*.cs"
  - "**/*.rb"
  - "**/*.php"
  - "**/*.c"
  - "**/*.cc"
  - "**/*.cpp"
  - "**/*.h"
  - "**/*.hpp"
  - "**/*.proto"
  - "**/*.graphql"
  - "**/*.sql"
needs-expert-review: true
severity: medium
title: 缺依赖倒置
source: agent-drafted
---
高层模块为了实现解耦而声明的接口，被低层模块直接 import 实现类，倒置只有一半：高层仍依赖低层实现。
必须指出接口与实现类，以及高层模块中的 import 位置。
不算：仓库声明不做依赖倒置（例如单进程小项目）。
