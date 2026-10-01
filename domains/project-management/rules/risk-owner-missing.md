---
name: risk-owner-missing
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: medium
source: agent-drafted
---

风险无责任人：风险条目没有 owners，或 owners 里的人不在 owners[] 登记中。没有人负责的风险在触发当天不会有人知道该怎么办。给出 riskId。不算：风险明确归属到某个团队且该团队在 teams[] 中唯一。

