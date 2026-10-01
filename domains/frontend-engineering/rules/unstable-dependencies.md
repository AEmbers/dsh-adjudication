---
name: unstable-dependencies
match:
  - **/*.tsx
  - **/*.jsx
needs-expert-review: true
title: 不稳定的依赖
severity: high
source: agent-drafted (t8); 尚无专家背书
---
是否把每次渲染新建的对象/函数/数组作为依赖，导致 effect 每轮都跑。

失败模式：依赖里放了内联对象，effect 无限循环。

取证义务：指出该值在何处被创建。

不算：配合 useMemo/useCallback 稳定化之后不构成问题。
