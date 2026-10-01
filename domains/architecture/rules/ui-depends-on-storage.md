---
name: ui-depends-on-storage
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
title: 表现层直连存储
source: agent-drafted
---
表现层模块直接依赖数据库驱动、连接池或存储客户端，绕过了领域层与应用层。
必须指出具体的存储客户端与调用点。
不算：项目本身就是一个数据库工具，表现层即存储操作层。
