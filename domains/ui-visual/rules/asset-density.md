---
name: asset-density
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

资源密度不足：位图资源只提供 1x，在高密度屏上被放大导致模糊。
取证义务：给出该资源路径与它缺失的 2x/3x 变体（或矢量替代）。
不算：装饰性背景图，模糊不影响可读性。
