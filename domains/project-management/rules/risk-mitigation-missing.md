---
name: risk-mitigation-missing
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: high
source: agent-drafted
---

应对措施不成立：mitigation 为空，或只是「待观察」「持续跟进」「保持沟通」这类没有动作的描述。没有动作的应对措施等于没有应对措施，而它会让风险看起来已被管理。给出 riskId 与原文。不算：mitigation 明确写了「接受该风险」并给出台理由。

