---
name: late-arriving-data
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

迟到数据未处理：窗口关闭后才到达的事件被丢弃，且没有任何记录。
失败模式：指标永久偏低，且没人知道少了多少。
取证义务：给出丢弃发生的位置（过滤条件那一行原文）与迟到判定依据的字段。
不算：业务上明确约定「只统计 T+1 已确认数据」且有据可查的不算。
