---
name: z-index-layering
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

层级脱离体系：z-index 使用魔法数字（9999 等），不在层级 token 上，导致弹窗被遮挡或误遮挡。
取证义务：给出该 z-index 值、它试图覆盖的层，以及层级 token 表。
不算：局部堆叠上下文内的 z-index（其数值不跨上下文可比）。
