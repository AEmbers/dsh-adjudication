---
name: skipped-or-disabled-tests
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
title: 被跳过的用例仍在仓库里
source: agent-drafted
---
`skip`/`xit`/`@Ignore`/`t.Skip` 标记的用例被计入覆盖率或被当作已覆盖。
必须指出被跳过的是哪一个用例，以及它原本要验证什么。
不算：显式标注原因与跟踪链接的临时跳过（此时应在报告中另行标注，而不是当成已覆盖）。
