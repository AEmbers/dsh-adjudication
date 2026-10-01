---
name: icon-alignment
match:
  - "**"
needs-expert-review: true
severity: low
source: agent-drafted
---

图标与文本未对齐：图标基线与相邻文本基线偏移，或图标尺寸不在图标尺寸 token 上。
取证义务：给出偏移量与两侧的尺寸来源。
不算：多行文本首行对齐（此时对齐基准是首行基线）。
