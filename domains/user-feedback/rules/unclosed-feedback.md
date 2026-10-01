---
name: unclosed-feedback
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

无闭环反馈：既没有 `closedBy`，也没有任何决策在 `addresses` 里提到它。用户报了，台账上没有任何东西接过它。取证义务：给出反馈 ID、它的严重度与影响面、以及被报次数 —— 这三项决定了它有多不该被漏掉。不算：反馈状态是 `duplicate` 且指向了被合并到的那条 —— 那是已知的合并，不是漏掉。
