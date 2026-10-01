---
name: inference-as-observation
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

推断当成观察：把「应该是 AES」写成「是 AES」，但没有可复现的观察步骤。
失败模式：下游据此做出错误的安全判断，且无法复核。
取证义务：必须同时给出观察步骤（命令/输入）与那句结论原文；结论若无法由步骤重放得出，就必须标为猜想。
不算：明确标注「猜想/待验证」的不算缺陷，只算证据强度低。
