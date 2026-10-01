---
name: threshold-tuning-on-test
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

阈值在测试集上选择：分类阈值/置信度门限由 test 指标决定。
失败模式：指标被阈值过拟合，线上无法达到。
取证义务：给出阈值选择依据的原文与它引用的数据分片，并说明该分片是 test。
不算：在 valid 上选阈值、只在 test 上评估且有据可查的不算。
