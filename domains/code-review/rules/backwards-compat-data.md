---
name: backwards-compat-data
match:
  - "**/*.sql"
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
severity: high
source: agent-drafted
---

数据格式兼容：把新字段写进只有新版本能读的位置、改变序列化格式、改变时间或金额单位、把可空列改成必填而旧数据仍为空。
必须指出读取旧数据的那个版本会发生什么。
