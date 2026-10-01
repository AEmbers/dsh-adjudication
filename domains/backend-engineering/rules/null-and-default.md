---
name: null-and-default
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
  - **/*.sql
needs-expert-review: true
title: 空值与默认值
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
新增可空字段的读取路径是否区分「空」与「零值」。

失败模式：把未设置的金额当成 0 元结算。

取证义务：指出区分空值与零值的具体代码。

不算：确实语义等价的场景要写明为什么等价。
