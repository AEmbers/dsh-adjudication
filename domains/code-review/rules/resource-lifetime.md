---
name: resource-lifetime
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

资源生命周期：文件、连接、事务、订阅、定时器、锁是否在**所有路径**（含异常与提前返回路径）被释放；defer/finally 是否真的覆盖了提前返回。
必须指出哪条返回路径漏了释放。
不算：既有代码里本来就正确的释放逻辑、以及「也许将来会有别的路径」。
