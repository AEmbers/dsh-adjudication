---
name: error-message-quality
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

错误信息：面向使用者的错误是否泄露了内部实现细节（类名、SQL、路径、堆栈）、是否缺少让用户能自助解决的信息、是否把不同的失败原因合并成同一个文案。
必须指出具体文案与它造成的后果。
