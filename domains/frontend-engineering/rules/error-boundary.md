---
name: error-boundary
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
needs-expert-review: true
title: 错误边界与降级
severity: high
source: agent-drafted (t8); 尚无专家背书
---
组件抛错时用户看到什么；是否会导致整页白屏。

失败模式：一个卡片组件出错，整个应用白屏。

取证义务：指出错误边界的位置与降级形态。

不算：路由级错误边界可以覆盖大部分场景，但要说明哪些区域未被覆盖。
