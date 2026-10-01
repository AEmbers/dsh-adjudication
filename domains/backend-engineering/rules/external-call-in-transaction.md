---
name: external-call-in-transaction
match:
  - **/*.go
  - **/*.java
  - **/*.py
  - **/*.ts
needs-expert-review: true
title: 事务内外部调用
severity: high
source: agent-drafted (t8); 尚无专家背书
---
事务里不能做会阻塞的外部调用（HTTP、消息、文件系统）。

失败模式：事务持有行锁等待第三方接口超时，连接池被拖垮。

取证义务：指出事务内的具体调用点。

不算：同进程的内存操作、本地缓存读写不算外部调用。
