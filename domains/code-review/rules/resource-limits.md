---
name: resource-limits
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
severity: high
source: agent-drafted
---

资源上限：循环、递归、重试、分页、批量查询是否有上界；是否可能构造出无界的内存增长（累积数组、缓存无淘汰、无限重试）。
必须指出上界在哪、或者为什么这里不可能无界。
不算：已经有明确上界但你觉得「可以更小」的场合。
