---
name: data-minimisation
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

数据最小化（GDPR Art.5(1)(c) / 个保法第 6 条）：为达成声明目的所必需之外的个人信息收集、存储、传输，即为问题。
取证义务：逐项指出「必要性缺失」的具体字段或流向，并说明它服务于哪个声明目的、为什么超出该目的。
不算：字段虽多但全部服务于同一目的且已声明；匿名化后不可再识别的聚合数据。
