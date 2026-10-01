---
name: audit-log-coverage-gap
match:
  - "service/**"
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.go"
  - "**/*.py"
  - "**/*.java"
needs-expert-review: true
severity: high
source: agent-drafted
---

审计覆盖缺口：对敏感数据的读取、导出、批量操作、权限变更没有审计记录。
取证义务：指出具体的操作类型与它的调用点，并说明为什么该操作需要留痕。
不算：只读的公开数据；已有独立的数据访问审计系统且可证明覆盖。
