---
name: undeclared-dependency-edge
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
title: 依赖边未在模块清单中声明
source: agent-drafted
---
源码里存在一条 import/调用边，而模块清单（modules 描述文件）中对应模块的依赖列表里没有它。清单与实现不一致，架构图是假的。
必须给出该边与清单中该模块的实际依赖列表。
不算：测试夹具、构建脚本、生成代码引入的边。
