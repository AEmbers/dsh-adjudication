---
name: memoization-cost
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.ts
needs-expert-review: true
title: 记忆化成本
severity: low
source: agent-drafted (t8); 尚无专家背书
---
memo/useMemo 是否掩盖了真正的问题；依赖比较是否比计算本身更贵。

失败模式：给每个组件加 memo，比较开销超过重渲染。

取证义务：给出能说明重渲染代价的依据（数据量、组件树规模）。

不算：确实昂贵的计算用 useMemo 是正确做法。
