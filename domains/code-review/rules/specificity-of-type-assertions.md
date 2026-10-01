---
name: specificity-of-type-assertions
match:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.kt"
  - "**/*.java"
  - "**/*.cs"
needs-expert-review: true
severity: medium
source: agent-drafted
---

类型断言与强制转换：用 as/强制转换把 unknown 变成具体类型而不校验、用非空断言 ! 绕过可能为空的检查、用 any 消解类型错误。
必须指出断言点与它在运行时可能收到的实际值。
