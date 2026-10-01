---
name: idempotency
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

幂等性：重试、重复投递、并发触发下是否会重复扣款、重复发送、重复创建；是否有幂等键或去重窗口。
不算：调用方已经保证只调用一次的纯函数。
