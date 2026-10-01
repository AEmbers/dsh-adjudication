---
name: hyperparameter-search-leak
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

超参搜索泄漏到评估：在包含 test 的集合上做过搜索，或搜索范围由 test 指标决定。
失败模式：报告的是「在 test 上最好的」配置，泛化被高估。
取证义务：给出搜索空间/早停依据的原文与它引用的分片。
不算：搜索只在 train/valid 上完成且有据可查的不算。
