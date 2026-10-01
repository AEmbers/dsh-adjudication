---
name: error-behavior-undocumented
match:
  - "**/*.md"
  - "**/*.mdx"
  - "**/*.rst"
  - "**/*.txt"
  - "**/*.adoc"
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.toml"
  - "**/*.ini"
  - "**/*.cfg"
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
needs-expert-review: true
severity: high
title: 抛出条件未文档化
source: agent-drafted
---
代码会在特定输入下抛异常或返回错误，文档只说「返回结果」而不说会失败。
必须指出触发的具体条件与抛出的具体错误类型/错误码。
不算：由语言运行时统一抛出的类型错误（传错类型本身即调用方错误）。
