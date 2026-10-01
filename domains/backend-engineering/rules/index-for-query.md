---
name: index-for-query
match:
  - **/*.sql
  - **/migrations/**
needs-expert-review: true
title: 查询有索引
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
新增查询模式是否有支撑索引；新增索引是否会被写放大。

失败模式：新查询全表扫描，或者为了一个低频查询加了三个索引拖慢写入。

取证义务：给出查询模式与索引的对应关系。

不算：小表（行数上界可论证）可以不建索引，但要给出上界。
