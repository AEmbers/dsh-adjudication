---
name: secrets-in-pipeline-config
match:
  - "**/*"
needs-expert-review: true
severity: medium
source: agent-drafted
---

凭据出现在 pipeline 配置或 SQL 里：连接串、token、密钥被内联。
失败模式：凭据进入日志、代码库与模型上下文。
取证义务：给出包含凭据的那一行原文（可以打码，但必须能定位到文件与行）。
不算：引用密钥管理器的名称（如 ${SECRET_ARN} 形式的占位）不算；仅是主机名不算。
