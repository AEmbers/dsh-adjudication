---
name: authz-and-tenant-isolation
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
severity: critical
source: agent-drafted
---

授权与租户隔离：新增的读写路径是否做了与同类路径一致的鉴权、是否遗漏了租户/账号维度的过滤条件、是否把「已认证」误当成「已授权」。
必须指出参照对象（同类已有路径）与缺失的那一步。
不算：需要产品决策才能确定的权限模型设计问题。
