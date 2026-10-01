---
name: n-plus-one
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

N+1 与重复 IO：在循环体内发起数据库查询、远程调用或文件读取；循环内重复计算本可复用的结果。
必须指出循环与其中的 IO 点。
不算：数据规模本身有硬上界的场合（例如固定长度枚举）。
