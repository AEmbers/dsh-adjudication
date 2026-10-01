---
name: domain-depends-on-framework
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
severity: high
title: 领域层依赖框架
source: agent-drafted
---
领域层模块直接 import 了应用框架或网络框架（web 框架、ORM、消息队列客户端）。
必须指出被引入的框架以及该模块所属的层次。
不算：该模块本身就位于框架适配层。
