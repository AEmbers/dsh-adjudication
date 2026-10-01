---
name: compute-budget-mismatch
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

算力/步数不对等：两个实验的训练步数或 GPU 小时差很多，结论却归因于算法改动。
失败模式：把「训练更久」当成「方法更好」。
取证义务：给出两个实验的 budget.steps / gpuHours 原文，并指出差异。
不算：明确做了等预算对照并有据可查的不算。
