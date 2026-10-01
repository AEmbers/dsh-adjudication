---
name: connection-pool
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
  - **/*.yaml
needs-expert-review: true
title: 连接池配置
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
连接池大小与并发模型是否匹配；池上限与下游容量是否匹配。

失败模式：应用连接池 200，数据库 max_connections 100。

取证义务：给出池大小与并发上限两边的数字。

不算：由平台统一配置时可以引用平台默认值，但要写出数值。
