---
name: status-vocabulary
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: low
source: agent-drafted
---

状态词表统一：status 使用了未声明的取值（如「进行中」「waiting」）而不是计划约定的枚举。自由文本状态让任何基于状态的统计都不可靠。给出任务 ID 与出现的取值。不算：取值在文档的 statusVocabulary 里已声明。

