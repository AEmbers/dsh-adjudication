---
name: spacing-scale
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

间距脱离栅格：间距值不在 4px 栅格上（如 13px、18px、30px），导致同类元素在不同位置间距不一致。
取证义务：给出该间距值与它应当取用的 spacing token。
不算：出于光学对齐需要的 ±1px 微调，且已在设计中注明。
