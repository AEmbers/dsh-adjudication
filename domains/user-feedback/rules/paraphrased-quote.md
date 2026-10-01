---
name: paraphrased-quote
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: critical
source: agent-drafted
---

转述引文：提交的引文不是用户原话的逐字片段，而是被改写得更通顺的版本。引文一旦被改写就不再是证据，它变成了评审者的说法。取证义务：给出你声称的原话片段与记录里实际的原文，并指出第一处差异的位置。不算：原文有换行或缩进差异（空白被折叠后一致）—— 那仍是逐字。
