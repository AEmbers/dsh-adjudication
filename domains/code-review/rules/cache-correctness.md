---
name: cache-correctness
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

缓存正确性：失效时机、键的构成是否包含全部决定结果的因素、缓存是否可能返回跨租户或跨用户的数据、写入路径是否同时更新缓存。
必须指出一个会读到陈旧或错误缓存的场景。
