---
name: test-set-leakage
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

测试集泄漏：test 分片参与过训练、选参或早停。
失败模式：离线指标显著高于线上，且复现不出。
取证义务：给出 splitsHash 或分片定义原文，并给出使用 test 做选择的那一段（超参搜索、早停、阈值选择都可）。
不算：仅在 test 上做最终评估不算泄漏；已经有独立的 holdout 且可引用不算。
