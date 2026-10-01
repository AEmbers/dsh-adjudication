---
name: uncovered-branch
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
severity: medium
title: 未被任何用例覆盖的分支
source: agent-drafted
---
源码里存在一条可达分支（if/else、switch case、try/catch、三元、循环体），而覆盖报告显示该分支的每一行都没有任何命中。
必须给出该分支的逐字原文与它所属的文件；必须说明它在什么输入下会被走到。
不算：测试夹具自身、生成代码、平台条件编译块（`#ifdef` 分支在目标平台上不可能走到时，属于配置而非缺口）。
