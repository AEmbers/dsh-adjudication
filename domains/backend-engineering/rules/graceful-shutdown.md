---
name: graceful-shutdown
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 优雅退出
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
进程退出时在途请求、后台任务是否被正确收尾。

失败模式：滚动发布时每个 Pod 都丢掉在途请求，表现为间歇性 502。

取证义务：给出信号处理与收尾超时。

不算：无状态且请求极短的场景可以简化，但要有依据。
