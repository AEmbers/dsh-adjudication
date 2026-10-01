---
name: class-imbalance-unhandled
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

类别不平衡未处理：整体指标被多数类主导，少数类表现未报告。
失败模式：少数类质量坍塌而总体指标仍「优秀」。
取证义务：给出类别分布证据与该类别的分项指标（或指出其缺失）。
不算：明确声明只关心多数类且业务上合理的不算。
