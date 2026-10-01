---
name: orphan-task
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

孤儿任务：既无前置也无后继的任务。它要么被真正独立地执行（合法），要么是漏登记的依赖（不合法）—— 必须区分：给出任务 ID，并说明它是否出现在任何里程碑或风险条目里。如果它不属于任何里程碑且没有依赖，缺的是**衔接**，不是任务本身。不算：被 idSpace 声明为外部输入的节点。

