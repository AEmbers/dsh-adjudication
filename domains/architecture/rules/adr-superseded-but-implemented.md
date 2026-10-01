---
name: adr-superseded-but-implemented
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
title: 已被取代的 ADR 决策仍在实现
source: agent-drafted
---
某条 ADR 状态为 superseded/rejected，但代码仍按该决策实现。两套意图并存，后人不知道该遵循哪一个。
必须给出 ADR 编号与它在代码中的实现位置。
不算：ADR 显式说明「迁移未完成、按阶段推进」并给出迁移跟踪项的场景。
