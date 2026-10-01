---
name: n-plus-one
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: N+1 查询
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
循环体内是否发起查询/远程调用。

失败模式：列表接口对每一行查一次用户信息。

取证义务：指出循环边界与查询位置。

不算：循环次数有硬上限（如 ≤10）时影响有限，但要把上限写出来。
