---
name: pricing-without-region
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

定价缺少地区与版本：一个价格被当成全球价格。
失败模式：定价结论不适用，且误导决策。
取证义务：给出价格原文与页面上的地区/版本信息（或指出其缺失）。
不算：明确限定某地区的不算。
