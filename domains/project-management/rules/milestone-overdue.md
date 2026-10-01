---
name: milestone-overdue
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

里程碑与任务状态矛盾：due 已过而包含的任务仍为 todo，或包含的任务状态为 blocked。给出里程碑 ID、due 与阻塞任务。不算：把 blocked 任务的阻塞原因写在风险条目里且已有应对措施 —— 那仍是风险，但不算矛盾。

