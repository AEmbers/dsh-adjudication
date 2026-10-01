---
name: proto-field-numbers
match:
  - **/*.proto
needs-expert-review: true
title: 字段号不可复用
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
删除的 protobuf 字段号必须 reserved，不得回收给新字段。

失败模式：删掉 field 3 又把 3 分配给新字段，历史消息被新代码按新语义解析。

取证义务：给出被删字段号与 reserved 语句。

不算：从未发布过的字段可以复用，但要说明它未发布。
