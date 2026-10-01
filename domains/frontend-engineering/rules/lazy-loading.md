---
name: lazy-loading
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.ts
  - **/*.vue
needs-expert-review: true
title: 按需加载
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
重组件/重路由是否用了懒加载；懒加载边界是否会导致瀑布式请求。

失败模式：进入首页就加载了后台管理模块。

取证义务：指出可懒加载的边界与当前加载时机。

不算：首屏必需的组件不该懒加载，懒加载不是越多越好。
