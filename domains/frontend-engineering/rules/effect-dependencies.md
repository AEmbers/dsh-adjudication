---
name: effect-dependencies
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
needs-expert-review: true
title: 依赖数组完整
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
useEffect/useMemo/useCallback 的依赖数组是否覆盖了闭包里用到的所有可变值。

失败模式：依赖漏了 id，切换商品后仍显示上一个商品的数据。

取证义务：指出闭包中用到但未进入依赖的值。

不算：确实稳定不变的值（模块常量、ref.current）不必列入，但要能说明它为什么稳定。
