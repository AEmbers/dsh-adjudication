---
name: responsive-breakpoints
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

断点脱离体系：使用了不在既定断点集中的宽度，或同一组件在相邻断点之间布局塌陷。
取证义务：给出该宽度值与既定断点集。
不算：内容驱动的容器查询断点，其取值由内容长度推导且已注明。
