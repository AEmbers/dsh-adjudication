---
name: data-filtering-difference
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

过滤条件不同：两次实验用了不同的数据清洗/过滤（去重、去异常、最小长度）。
失败模式：比较的是两个数据集，而不是两个模型。
取证义务：给出两处过滤条件的原文（或声明其缺失），并说明差异。
不算：过滤条件一致且有据可查的不算。
