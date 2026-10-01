---
name: legal-authorisation-missing
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

缺少授权说明：分析对象的取得方式与授权范围没有声明。
失败模式：合规风险，且发布后无法撤回。
取证义务：给出产物清单里 obtainedBy/authorisation 的原文，或指出其缺失。
不算：公开样本（公开固件、CTF 题）且有出处的不算。
