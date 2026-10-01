---
name: train-test-overlap
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

训练集与测试集重叠：同一来源的样本按时间/用户切分不当或去重不彻底。
失败模式：指标虚高，且随数据增长越来越虚高。
取证义务：给出切分依据（时间窗口、用户 id、去重键）的原文，并说明重叠为何可能。
不算：明确按时间切分且给出时间戳证据的不算。
