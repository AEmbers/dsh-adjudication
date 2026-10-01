---
name: single-report-critical-loss
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

单报高损：被报次数只有 1，但原话描述的是数据丢失、资金错误或权限越权这类不可逆损失。按次数排序时它排在最后，而它本该排在最前。取证义务：给出反馈 ID、被报次数、以及原话中描述不可逆损失的那句话。不算：原话描述的是可撤销的展示错误（一次刷新即恢复）—— 那不属于本规则的不可逆类别。
