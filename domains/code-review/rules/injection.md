---
name: injection
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
severity: critical
source: agent-drafted
---

注入：SQL、命令、路径、模板、日志注入。拼接字符串构造查询或命令、把用户输入直接交给 shell、未净化的路径拼接（../）、把外部数据当格式串。
必须给出具体的拼接点与被污染的变量。
不算：已经走参数化/转义路径的调用，「看起来像拼接」但实际是常量。
