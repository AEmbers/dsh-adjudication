---
name: error-handling
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

错误处理：被忽略的 error/异常返回值、被吞掉的失败分支、只记日志不返回的失败路径、把错误降级成默认值的兜底。
只有当本次变更**引入或改变**了该路径时才算；既有代码的既有问题不算。
不算：风格偏好式的错误包装、日志文案措辞、既有的空 catch（除非变更触碰了它）。
