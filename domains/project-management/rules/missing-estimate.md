---
name: missing-estimate
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

缺失估算：任务没有 estimateDays，却已经被排进里程碑。没有估算的任务无法参与关键路径计算，也无法判断里程碑是否现实。给出任务 ID 与它所属的里程碑。不算：状态为 done 的任务（已完成的任务不需要估算）。

