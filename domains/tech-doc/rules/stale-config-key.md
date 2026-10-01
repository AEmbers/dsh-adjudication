---
name: stale-config-key
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
title: 文档中的配置键不存在
source: agent-drafted
---
文档给出的配置键（YAML/JSON/TOML 字段名）在代码的配置解析处找不到。
必须给出文档键名与代码实际读取的键名。
不算：由外部框架（非本仓库代码）解析的键。
