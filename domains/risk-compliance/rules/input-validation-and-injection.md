---
name: input-validation-and-injection
match:
  - "**/*.sql"
  - "**/*.ts"
  - "**/*.js"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
  - "**/*.php"
  - "**/*.rb"
needs-expert-review: true
severity: high
source: agent-drafted
---

注入：SQL/命令/模板/表达式注入 —— 外部输入未经参数化或白名单即进入执行上下文。
取证义务：必须给出具体的拼接点与被污染的变量；只说「可能有注入」不算发现。
不算：使用参数化查询或 ORM 绑定变量的调用点；白名单枚举后的值进入拼接。
