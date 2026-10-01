---
name: pii-in-logs
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 日志中的个人信息
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
新增日志是否包含邮箱、手机号、身份标识、支付信息等。

失败模式：排查问题时把用户手机号打进日志平台。

取证义务：指出日志字段与它是否被脱敏。

不算：内部不可逆的匿名 ID 可以记录，但要说明它不可逆。
