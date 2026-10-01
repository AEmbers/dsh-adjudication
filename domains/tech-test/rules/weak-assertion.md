---
name: weak-assertion
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
title: 断言过弱，测不出回归
source: agent-drafted
---
用例执行了代码但只断言「不抛异常」「返回非 null」「长度大于 0」这类恒真或近乎恒真的条件；实现改坏了它依然绿。
必须说明**哪一条具体的错误改动**不会被现有断言发现。
不算：冒烟用例（名字与目录明确标为 smoke，且仓库另有精细断言的同路径用例）。
