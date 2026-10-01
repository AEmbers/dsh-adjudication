---
name: eval-set-contamination
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

评估集污染：评估样本与预训练语料/外部数据重叠。
失败模式：指标虚高，且无法通过重跑发现。
取证义务：给出评估集来源与去污染步骤的原文，或明确指出该步骤缺失。
不算：明确做了 n-gram/embedding 去污染并有据可查的不算。
