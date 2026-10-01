---
name: example-does-not-run
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
title: 示例代码无法运行
source: agent-drafted
---
示例调用了不存在的函数、传了签名里没有的参数、或缺少必需的前置步骤，照抄会失败。
必须指出失败的那一行与它对应不上源码的地方。
不算：示例开头显式标注为「伪代码 / 示意」的片段。
