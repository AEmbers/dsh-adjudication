---
name: frequency-without-severity
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

只有频次没有严重度：条目只有 `frequency`，于是排序只能按次数，而这正是把低频高损项淹没的机制。取证义务：给出反馈 ID 与被报次数。不算：`frequency` 为 1 且台账标注为一次性事件 —— 那仍然需要严重度，一次数据丢失也不该因为没有复现次数而失分。
