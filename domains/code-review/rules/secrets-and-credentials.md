---
name: secrets-and-credentials
match:
  - "**/*"
needs-expert-review: true
severity: critical
source: agent-drafted
---

凭据与敏感值：把密钥、口令、令牌、连接串硬编码进源码、配置、测试或 fixture；把凭据写进日志、错误信息、上报字段；把凭据通过变更提交进仓库。
只报告本次变更引入的凭据，并指出具体行。已存在于历史的凭据不在此规则的判定范围（那是另一件事，需要的话单独提出）。
