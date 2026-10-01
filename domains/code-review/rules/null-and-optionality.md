---
name: null-and-optionality
match:
  - "**/*.go"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
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
  - "**/*.h"
  - "**/*.hpp"
needs-expert-review: true
severity: medium
source: agent-drafted
---

空值语义：新增的可空字段是否在所有读取点都被处理；可选链/空值合并是否把「缺失」和「空值」混为一谈；提前返回是否遗漏了必须执行的清理。
不算：语言层面已由类型系统保证非空、且变更没有削弱该保证的场合。
