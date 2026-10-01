---
name: cross-border-transfer
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

数据出境：个人数据出境缺少合法性基础与合同工具（SCC / 认证 / 单独同意），或存在未申报的境外接收方。
取证义务：指出出境的具体数据项、接收方与目的地，以及缺失的工具或申报。
不算：境内但使用境外 CDN 边缘节点的静态资源分发（不承载个人数据）。
