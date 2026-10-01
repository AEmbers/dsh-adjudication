---
name: missing-regression-test-for-fix
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
title: 缺陷修复缺回归用例
source: agent-drafted
---
改动自称修复了某个缺陷，但没有新增或修改任何用例；该缺陷下次可以无声复发。
必须指出应新增哪一条用例（输入与期望）。
不算：纯文档、纯配置、无可观测行为变化的改动。
