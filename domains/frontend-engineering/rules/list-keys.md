---
name: list-keys
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
  - **/*.svelte
needs-expert-review: true
title: 列表 key
severity: high
source: agent-drafted (t8); 尚无专家背书
---
列表 key 必须稳定且唯一，禁止用数组下标。

失败模式：列表中间插入一项，后续所有项的状态错位。

取证义务：指出 key 的来源字段。

不算：静态不变列表用下标可以接受，但要说明它不会重排。
