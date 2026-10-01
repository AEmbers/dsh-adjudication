---
name: elevation-scale
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

阴影脱离层级：阴影值不在 shadow/elevation token 上，或同一层级在不同组件中使用不同阴影。
取证义务：给出该阴影值与它应当对应的层级 token。
不算：为特定品牌场景单独定义的阴影 token（只要它已在 token 表中登记）。
