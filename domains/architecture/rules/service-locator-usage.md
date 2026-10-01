---
name: service-locator-usage
match:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/*.py"
  - "**/*.rs"
  - "**/*.go"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.swift"
  - "**/*.cs"
  - "**/*.rb"
  - "**/*.php"
  - "**/*.c"
  - "**/*.cc"
  - "**/*.cpp"
  - "**/*.h"
  - "**/*.hpp"
  - "**/*.proto"
  - "**/*.graphql"
  - "**/*.sql"
needs-expert-review: true
severity: medium
title: 服务定位器反模式
source: agent-drafted
---
模块通过运行期容器查询（getService("x")、container.resolve）获取依赖，而不是在构造时注入，依赖图因此看不到真实依赖。
必须指出被查询的服务名与该查询点。
不算：引导/装配代码在启动阶段一次性解析依赖。
