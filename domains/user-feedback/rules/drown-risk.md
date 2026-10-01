---
name: drown-risk
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

高损低频被淹没：某条反馈的「严重度 × 影响面」排在前四分之一，而被报次数排在倒数一半 —— 按次数排序时它会被挤到看不见的地方。取证义务：给出反馈 ID、它在两个排序里的位置、以及它的严重度与影响面取值。不算：这条已经在报告的单独清单里被点名 —— 那是本条规则的期望结果，不是违规。
