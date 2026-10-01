---
name: return-shape-mismatch
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
title: 返回值描述与实现不符
source: agent-drafted
---
文档描述的返回类型、字段名或结构，与代码实际返回的对象不一致（例如文档说返回数组，代码返回 `{ items }`）。
必须给出文档描述与一个能证明实际返回形状的代码位置。
不算：文档描述的是公开接口、而实现返回内部对象但经显式适配层转换（此时需给出适配层位置）。
