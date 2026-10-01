---
name: subset-metric-reporting
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

只报子集：只报告提升的类别或指标，未报告整体分布。
失败模式：读者以为整体提升，实际是选择性呈现。
取证义务：给出被报告子集的那一行与未报告范围的证据（per-class 报告、指标清单）。
不算：明确声明「本实验只评估 X 类别」且有范围说明的不算。
