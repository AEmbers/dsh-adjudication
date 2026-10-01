---
name: version-claim-unsupported
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
severity: medium
title: 版本/兼容性声明无依据
source: agent-drafted
---
文档声称「自 vX.Y 起支持」「兼容 Z 版本」，而仓库的版本记录/发布文件里找不到对应依据。
必须指出该声明与版本记录的具体矛盾。
不算：版本号来自本仓库之外的发布通道（如平台文档站）且已给出出处链接。
