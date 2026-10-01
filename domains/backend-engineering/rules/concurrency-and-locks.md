---
name: concurrency-and-locks
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 并发与锁
severity: high
source: agent-drafted (t8); 尚无专家背书
---
共享状态的读写是否有同步；锁的获取顺序是否会造成死锁；锁粒度是否过大。

失败模式：两级锁顺序不一致，压测时死锁。

取证义务：指出共享状态与保护它的机制。

不算：只在一个 goroutine/线程内使用的状态不用同步，但要能证明它不外泄。
