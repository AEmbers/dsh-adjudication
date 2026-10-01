---
name: layout-shift
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.css
  - **/*.scss
  - **/*.vue
needs-expert-review: true
title: 布局抖动
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
图片/广告/异步内容是否预留了尺寸，避免加载后跳版。

失败模式：图片加载完成后整页下移，用户点错按钮。

取证义务：指出宽高或占位策略。

不算：内容高度天然不确定时的骨架屏可以接受，但要说明它如何稳定尺寸。
