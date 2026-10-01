---
name: cleanup-on-failure
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

失败路径的清理：在把资源交给外部之后失败时，是否留下半成品（部分写入的文件、已创建但未引用的对象、已发送但未回滚的消息）。
不算：有明确且已验证的补偿机制覆盖的场合。
