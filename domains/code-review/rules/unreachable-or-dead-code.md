---
name: unreachable-or-dead-code
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
severity: low
source: agent-drafted
---

死代码与不可达分支：变更后永远不会走的条件、被后续语句覆盖的赋值、删除了调用方却留下的实现、注释掉的代码块。
不算：明确标注为临时开关且有计划的功能开关。
