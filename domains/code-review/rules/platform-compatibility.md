---
name: platform-compatibility
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
severity: medium
source: agent-drafted
---

平台兼容：路径分隔符、大小写敏感的文件系统、行尾、locale 与编码、shell 差异、Windows 与 POSIX 的文件锁语义。
必须指出在哪个平台上会失败、以及为什么。
