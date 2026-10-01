---
name: incremental-window-overlap
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

增量窗口重叠或空洞：水位线推进与过滤条件不一致，两个批次覆盖同一段时间，或漏掉一段。
失败模式：重复计数或静默漏数，两者都不会让任务失败。
取证义务：给出窗口表达式那一行原文、水位线字段名，并说明它与上次运行窗口的关系。
不算：全量刷新任务不算；窗口边界由引擎的 exactly-once 语义保证且有据可查的不算。
