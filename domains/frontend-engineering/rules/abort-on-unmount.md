---
name: abort-on-unmount
match:
  - **/*.ts
  - **/*.tsx
  - **/*.js
  - **/*.jsx
needs-expert-review: true
title: 取消而非忽略
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
清理函数是否真正取消在途请求，而不是仅仅忽略结果。

失败模式：大量在途请求堆积，移动端流量与电量大增。

取证义务：指出取消信号的传递路径。

不算：由数据层统一管理缓存与去重的路径可以简化，但要说明它在哪里做。
