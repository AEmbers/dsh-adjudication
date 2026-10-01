---
name: input-validation
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

输入校验：来自请求体、查询参数、路径参数、环境变量、外部服务响应的数据在被信任之前是否被校验；类型断言/反序列化是否可能产出与声明不符的值。
重点看变更是否**新增**了一条未经校验就把外部数据当内部数据用的路径。
