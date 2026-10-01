---
name: api-compatibility
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

接口兼容性：删除或重命名字段、改变字段类型或语义、收紧枚举范围、改变默认值、改变状态码或错误格式；对已发布接口而言这些都是破坏性变更。
必须指出调用方会如何受影响，并说明是否有版本化/迁移路径。
