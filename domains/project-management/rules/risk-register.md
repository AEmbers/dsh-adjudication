---
name: risk-register
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

风险登记：已识别的风险是否有触发条件、影响面与应对措施。取证义务：逐条给出 riskId，并指出缺失的是哪一项。不算：只写了「关注 X 风险」而没有触发条件的条目。

