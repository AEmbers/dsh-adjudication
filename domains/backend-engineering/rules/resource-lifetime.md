---
name: resource-lifetime
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 资源生命周期
severity: high
source: agent-drafted (t8); 尚无专家背书
---
连接、文件、游标、锁、临时对象是否在所有路径上释放。

失败模式：错误路径提前 return，rows 没关闭，连接池缓慢耗尽。

取证义务：指出每个获取点对应的释放点。

不算：由语言运行时保证的（GC 管理的纯内存对象）不用列。
