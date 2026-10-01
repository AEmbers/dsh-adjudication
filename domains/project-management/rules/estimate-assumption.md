---
name: estimate-assumption
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: medium
source: agent-drafted
---

估算假设：估算是否写出了它所依赖的假设（人力、环境、上下游可用性）。没有假设的估算在假设失效时会静默变成错数字。不算：估算区间已给出上下界且说明了差异来源。

