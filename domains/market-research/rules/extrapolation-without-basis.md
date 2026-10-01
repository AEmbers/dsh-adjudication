---
name: extrapolation-without-basis
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

外推没有依据：用两个点推出一条曲线，或用历史增速推十年。
失败模式：结论的置信度远高于证据。
取证义务：给出被外推的原始点（至少两处原文）与外推所假设的增长率。
不算：明确标注「线性外推、仅供量级参考」的不算。
