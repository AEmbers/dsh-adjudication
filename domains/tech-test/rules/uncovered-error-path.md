---
name: uncovered-error-path
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
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/*_test.*"
  - "**/test_*.py"
  - "**/tests/**"
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.toml"
  - "**/*.ini"
  - "**/*.cfg"
needs-expert-review: true
severity: high
title: 错误路径与异常分支未覆盖
source: agent-drafted
---
抛错、返回错误码、回滚、重试、降级这些路径一条用例都没走到。这类分支平时不执行，出问题时才执行 —— 未覆盖等于未验证。
必须指出具体是哪个错误条件（哪个调用会失败、失败后应发生什么）。
不算：不可达的防御性 `panic`（例如穷尽 switch 之后的 default）。
