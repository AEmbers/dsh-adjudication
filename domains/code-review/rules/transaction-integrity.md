---
name: transaction-integrity
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

事务完整性：多步写入是否在同一事务内、失败时是否回滚、事务内是否包含网络等待或其他不可控耗时操作、是否出现了嵌套或跨服务的伪事务。
不算：单条语句天然原子的场合。
