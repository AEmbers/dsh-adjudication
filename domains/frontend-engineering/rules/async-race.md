---
name: async-race
match:
  - **/*.ts
  - **/*.tsx
  - **/*.js
  - **/*.jsx
  - **/*.vue
needs-expert-review: true
title: 异步竞态
severity: high
source: agent-drafted (t8); 尚无专家背书
---
是否假设了请求返回顺序；连续触发时后发先至会怎样。

失败模式：先搜 A 再搜 B，A 的慢响应覆盖了 B 的结果。

取证义务：指出竞态窗口与当前的处理方式。

不算：有请求序号/取消机制的路径不构成问题。
