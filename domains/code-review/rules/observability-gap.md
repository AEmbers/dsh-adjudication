---
name: observability-gap
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

可观测性缺口：新增的失败路径没有日志或指标、错误被吞进一个无人看的返回值、关键的降级行为没有任何痕迹。
必须指出「这条路径失败后，运维靠什么发现」。
不算：纯粹的内部辅助函数。
