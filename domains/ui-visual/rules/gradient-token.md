---
name: gradient-token
match:
  - "**"
needs-expert-review: true
severity: low
source: agent-drafted
---

渐变脱离 token：渐变起止色是硬编码值而不是已登记的颜色 token。
取证义务：给出渐变定义与各停止点应对应的 token 名。
不算：渐变停止点使用了已登记的 token 但顺序不同。
