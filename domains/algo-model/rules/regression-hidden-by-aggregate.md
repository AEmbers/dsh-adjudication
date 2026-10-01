---
name: regression-hidden-by-aggregate
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

聚合指标掩盖了逐题回退：总体分数上升，但某个子集/某个指标在退步。
失败模式：发布后才发现某个重要类别的质量下降，而发布依据是一张只有总体数字的表。
取证义务：必须同时给出上升与下降两处原文（两个实验、两个指标），并说明聚合口径。
不算：只给总体上升而没有任何逐题证据不算缺陷（那是证据不足）；下降项本身在同一个实验里已被明确标注为「已知取舍」并有据可查的不算。
