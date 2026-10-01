---
name: column-type-narrowed
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

类型收窄或隐式转换：numeric 截断为 int、timestamp 截断到日期、unicode 长度按字节截断。
失败模式：精度静默丢失，历史对比口径改变，且失败发生在很久之后的另一张表里。
取证义务：给出字段名、源类型与目标类型各自的位置（两段原文），以及能说明截断的那一行转换表达式。
不算：同一类型族内的显式变更且下游同步更新不算；只是改名不算。
