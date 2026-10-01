---
name: milestone-unreachable
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: high
source: agent-drafted
---

里程碑不可达：从当前 todo 任务出发，沿依赖边正向走，无法到达里程碑列出的某个任务，说明它的前置链在路上断了（有未被满足的 unknownTarget，或链上任务被归档）。取证义务：给出可达集与目标任务的差集。

