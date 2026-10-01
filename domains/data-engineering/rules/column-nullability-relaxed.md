---
name: column-nullability-relaxed
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

可空性放宽：产出字段从 not null 变成 nullable，而下游仍按非空处理（连接键、聚合分母、not null 约束）。
失败模式：NULL 静默传播到报表，聚合结果偏小，且没有任何一步报错。
取证义务：给出表名与字段名、SQL 中该字段的来源表达式，以及下游把它当非空使用的具体位置（另一段可抄写的原文）。
不算：字段本来就是 nullable 不算；下游显式做了 coalesce/nullif 防御的不算（要引用那段代码）。
