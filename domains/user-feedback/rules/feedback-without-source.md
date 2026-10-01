---
name: feedback-without-source
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: low
source: agent-drafted
---

来源缺失：反馈没有 `source`，无法判断它来自客户、内部还是自动探测 —— 也无法判断它该按什么口径定影响面。取证义务：给出反馈 ID 与它的原话片段。不算：原话里明确写了渠道（「在应用商店评论里说」）—— 那信息在，只是没进字段，标为「应结构化」而非缺失。
