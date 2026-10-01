---
name: config-and-flags
match:
  - "**/*.yml"
  - "**/*.yaml"
  - "**/*.json"
  - "**/*.toml"
  - "**/*.ini"
  - "**/*.env*"
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

配置与开关：新增配置项是否有默认值、默认值是否安全、开关的两个分支是否都可用、配置错误时是失败关闭还是失败打开。
必须说明配置缺失时系统会走向哪一侧。
