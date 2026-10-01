---
name: migration-safety
match:
  - **/*.sql
  - **/migrations/**
needs-expert-review: true
title: 迁移安全
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
DDL 是否可在不停机的情况下执行：锁表时长、向后兼容性、回滚方案。

失败模式：ALTER TABLE 加非空默认值锁表十分钟。

取证义务：给出现有表规模、锁级别与回滚步骤。

不算：维护窗口内执行的迁移可以放宽，但要写明窗口。
