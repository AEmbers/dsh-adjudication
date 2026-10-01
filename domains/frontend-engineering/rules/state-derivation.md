---
name: state-derivation
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.ts
  - **/*.vue
needs-expert-review: true
title: 状态可推导
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
是否把可推导的值存成了独立状态，从而产生不一致窗口。

失败模式：total 和 items 各自存一份，删除商品后 total 没更新。

取证义务：指出两份状态的同步点。

不算：为性能刻意缓存是合法的，但要说明失效时机。
