---
name: contrast-large-text
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

大字号文本对比度：≥24px 或 ≥18.66px 粗体的文本，对比度低于 3:1。
取证义务：给出计算出的比值、字号与字重。
不算：仅略低于 3:1 且该文本同时有大字号之外的替代可读形式（此时降级为低优先级发现并说明）。
