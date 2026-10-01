---
name: image-alt
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
  - **/*.html
needs-expert-review: true
title: 图片替代文本
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
图片是否有替代文本；装饰性图片是否显式标注为空替代。

失败模式：信息图没有 alt，屏幕阅读器完全跳过。

取证义务：指出图片与它的 alt 值。

不算：纯装饰图 alt="" 是正确做法，不算缺失。
