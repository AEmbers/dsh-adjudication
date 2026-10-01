---
name: assertion-on-mock-only
match:
  - "**/*.go"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.mjs"
  - "**/*.cjs"
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
  - "**/*.cu"
  - "**/*.h"
  - "**/*.hpp"
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/*_test.*"
  - "**/test_*.py"
  - "**/tests/**"
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.toml"
  - "**/*.ini"
  - "**/*.cfg"
needs-expert-review: true
severity: high
title: 只断言 mock 的调用，不断言结果
source: agent-drafted
---
用例验证的是「桩被以某参数调用过」，而没有任何一句断言校验真实返回值或副作用。
必须指出该用例声称覆盖的行为，以及若实现把该行为整段删掉、用例是否仍会绿。
不算：显式测试协议契约的交互式用例（名字或注释写明测的是调用协议）。
