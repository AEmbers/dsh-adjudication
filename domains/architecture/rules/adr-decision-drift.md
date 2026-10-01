---
name: adr-decision-drift
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
title: 实现偏离 ADR 决策
source: agent-drafted
---
代码的实际做法与 accepted 状态的 ADR 决策不同（选用了另一方案、放弃了约束）。
必须同时引用 ADR 决策原文与代码中的偏离点。
不算：ADR 本身标注 scope 不覆盖该处，或偏离处另有 accepted 的 ADR 覆盖。
