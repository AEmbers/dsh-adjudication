---
name: privilege-escalation
match:
  - "**/*.ts"
  - "**/*.js"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
  - "**/*.sql"
needs-expert-review: true
severity: high
source: agent-drafted
---

提权路径：用户可控输入参与角色/权限判定、文件路径解析、命令拼接，或存在从低权限上下文进入高权限上下文的未校验通道。
取证义务：给出受污染变量的来源与它到达判定点的完整路径。
不算：仅存在提权「可能性」但污染路径被独立的强类型校验或白名单截断。
