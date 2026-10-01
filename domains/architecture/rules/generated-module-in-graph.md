---
name: generated-module-in-graph
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
title: 生成代码进入依赖图
source: agent-drafted
---
依赖图里出现由代码生成器产出的模块（protobuf、ORM、schema 生成物），但没有任何地方声明它是生成物。
必须指出该模块的生成来源。
不算：生成目录在闸门中已被排除，或生成物带有明确的生成头注释。
