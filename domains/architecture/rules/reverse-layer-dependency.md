---
name: reverse-layer-dependency
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
severity: high
title: 反向分层依赖
source: agent-drafted
---
依赖方向与声明的层次顺序相反：由内层指向外层（例如 domain 依赖 application，或 infrastructure 依赖 domain）。
必须指出两端的层次声明来自哪里（模块清单、目录约定、还是架构文档）。
不算：层次顺序本身没有在任何地方声明过——那种情况下只能说「层次未声明」，不能断言方向错误。
