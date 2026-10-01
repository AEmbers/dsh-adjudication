---
name: split-hash-mismatch
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

分片指纹不一致：不同实验的 splitsHash 不同，却被放在同一张对比表里。
失败模式：对比不可比，且因为指纹不显眼而无人察觉。
取证义务：给出两个 experiments 的 splitsHash 原文，并指出对比表把它们并列。
不算：明确说明「分片已重新生成、结论仅限同族内部比较」的不算。
