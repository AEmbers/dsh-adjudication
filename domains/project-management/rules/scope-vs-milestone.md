---
name: scope-vs-milestone
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

范围与里程碑错配：某个里程碑包含的任务总量（估算之和）明显超出它与上一个里程碑之间的可用时间。给出里程碑 ID、任务估算之和与间隔天数。不算：有并行的其他团队任务分担，且已在该里程碑的说明里写明。

