---
name: cyclic-dependency
match:
  - "**/*.go"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/*.py"
  - "**/*.rs"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.cs"
  - "**/*.rb"
  - "**/*.php"
  - "**/*.swift"
  - "**/*.c"
  - "**/*.cc"
  - "**/*.cpp"
  - "**/*.cu"
  - "**/*.h"
  - "**/*.hpp"
  - "**/adr/**/*.md"
  - "**/adrs/**/*.md"
  - "**/decisions/**/*.md"
  - "**/docs/**/*.md"
  - "**/package.json"
  - "**/pyproject.toml"
  - "**/go.mod"
  - "**/Cargo.toml"
  - "**/pom.xml"
  - "**/*.csproj"
  - "**/modules.yaml"
  - "**/modules.yml"
  - "**/architecture.json"
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.toml"
  - "**/*.ini"
  - "**/*.cfg"
needs-expert-review: true
severity: high
title: 模块间存在依赖环
source: agent-drafted
---
依赖图中存在一个长度 ≥2 的环：沿 A→B→…→A 走回起点。环会让二者无法独立构建、测试或部署，并让初始化顺序成为隐式契约。
必须给出构成环的完整边序列（A → B → C → A）。
不算：同一包内部的模块互引（合并语义上它们是一个单元，此时问题转移到「该不该合并」而不是环）。
