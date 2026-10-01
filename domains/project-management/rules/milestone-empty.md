---
name: milestone-empty
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

空里程碑：milestones[].tasks 为空，或列出的任务全部不在 tasks[] 里。里程碑没有承接任何真实任务时，它只是一个日期。给出里程碑 ID 与其 tasks 内容。不算：milestone 明确标注为「检查点」且 due 为空。

