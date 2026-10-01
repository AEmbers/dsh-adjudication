---
name: opacity-vs-rgba
match:
  - "**"
needs-expert-review: true
severity: low
source: agent-drafted
---

透明度表达不一致：同一半透明效果有时用 opacity 属性、有时用 rgba 颜色，导致叠加结果不同。
取证义务：给出两处写法与其实际渲染值差异。
不算：只用其中一种写法（一致性本身没有问题）。
