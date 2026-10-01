---
name: pii-in-warehouse-columns
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

PII 进入分析层：邮箱、手机号、身份证、地址类字段被复制到宽表且未做脱敏或访问控制。
失败模式：数据在更大范围内可访问，合规成本远超当初省下的时间。
取证义务：给出字段名、它所在表，以及新增该字段的那一行原文。
不算：本来就是脱敏列（有 hash/mask 证据）不算；明文仅在受控原始层且访问控制有据可查的不算。
