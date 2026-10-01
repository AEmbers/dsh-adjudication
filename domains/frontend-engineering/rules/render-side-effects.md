---
name: render-side-effects
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
  - **/*.svelte
needs-expert-review: true
title: 渲染期副作用
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
渲染函数体里不能有副作用（发请求、写存储、改全局、起定时器）。

失败模式：一次渲染发一次请求，重渲染风暴把后端打满。

取证义务：指出副作用语句的位置。

不算：纯计算（map/filter/reduce）不算副作用。
