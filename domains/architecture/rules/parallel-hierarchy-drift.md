---
name: parallel-hierarchy-drift
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
  - "**/*.md"
  - "**/*.mdx"
  - "**/*.rst"
  - "**/*.adoc"
  - "**/adr/**"
  - "**/decisions/**"
needs-expert-review: true
severity: low
title: 并行层级漂移
source: agent-drafted
---
依赖图里存在两条本应对称的层级路径（例如 src/api 与 src/workers），一侧的模块结构已经漂移，另一侧没有对应变化。
必须列出两侧的模块 id 并指出漂移的具体位置。
不算：两侧本就承担不同职责，对称性从未被声明。
