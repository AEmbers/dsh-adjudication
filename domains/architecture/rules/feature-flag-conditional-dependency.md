---
name: feature-flag-conditional-dependency
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
severity: low
title: 特性开关造成的条件依赖
source: agent-drafted
---
依赖图上的某条边只在特定特性开关或构建标记下成立，静态依赖图没有反映这种条件性，覆盖率与影响分析会失真。
必须指出该开关名与受影响的边。
不算：开关在编译期完全内联且没有任何运行期分支。
