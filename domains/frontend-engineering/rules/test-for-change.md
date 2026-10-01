---
name: test-for-change
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.ts
  - **/*.vue
needs-expert-review: true
title: 变更有测试
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
本次交互变更是否有覆盖它的测试；没有测试时是否说明了手工验证方式。

失败模式：修了一个竞态但没有任何回归测试，下次重构又回来。

取证义务：指出测试文件或用例名；没有测试时给出验证步骤。

不算：纯样式改动可以没有测试，但要有视觉验证步骤。
