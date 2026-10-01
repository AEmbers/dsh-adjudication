---
name: implicit-cycle-by-types
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
title: 类型层隐式环
source: agent-drafted
---
运行期依赖图无环，但类型/接口声明互相引用，形成编译期可见的环，妨碍拆分与增量构建。
必须给出构成环的类型名与所在模块。
不算：环由泛型约束造成且无法通过提取公共接口消除。
