---
name: averaging-mode-mismatch
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

平均方式不一致：micro/macro/weighted 混用，或分母不同（按样本 vs 按类别）。
失败模式：数值变化被误读为模型改进。
取证义务：给出该指标 definition 的原文，并给出另一处使用不同平均方式的原文。
不算：同一实验内两边一致的不算。
