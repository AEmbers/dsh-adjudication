---
name: parameter-not-in-source
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
title: 文档描述了源码里不存在的参数
source: agent-drafted
---
文档列出的参数名在源码签名里根本没有。这通常是从别的 API 复制过来忘了改的结果。
必须给出文档中的参数名与源码的实际参数列表。
不算：语法层面的可变参数（`*args`/`**kwargs`）按约定接收的具名键。
