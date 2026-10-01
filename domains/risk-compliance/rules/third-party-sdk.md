---
name: third-party-sdk
match:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.kt"
  - "**/*.swift"
needs-expert-review: true
severity: high
source: agent-drafted
---

第三方 SDK 回传：SDK 在初始化或后台回传设备标识、位置、通讯录等，且未出现在隐私政策与处理者清单中。
取证义务：指出 SDK 名称、回传字段与触发时机；「未在清单中」也要作为证据给出。
不算：仅引入依赖但没有任何回传调用点。
