---
name: declared-dependency-unused
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
severity: medium
title: 声明的依赖在源码中找不到使用
source: agent-drafted
---
清单声明 A 依赖 B，但 A 的源码里没有任何对 B 的引用。要么清单过时，要么依赖通过隐式全局/反射建立 —— 后者更危险。
必须给出该声明的边与搜索证据。
不算：以插件注册、IoC 容器、动态发现方式建立依赖的场景（此时应在清单中标注为动态边）。
