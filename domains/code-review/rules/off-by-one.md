---
name: off-by-one
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

边界偏移：区间开闭、长度与索引混用、分页的 offset/limit 语义、字符串切片的字节与字符之别。
必须给出一个会产生错误结果的具体输入。给不出具体输入就不要提出这条。
