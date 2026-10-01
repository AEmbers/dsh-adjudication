---
name: i18n-and-text
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
  - **/*.html
needs-expert-review: true
title: 文案与国际化
severity: low
source: agent-drafted (t8); 尚无专家背书
---
新增文案是否走 i18n 通道；是否把文案拼进逻辑（拼接语序、复数、日期格式）。

失败模式：英文语序下按钮文案读不通。

取证义务：指出文案来源；硬编码时说明为什么不走 i18n。

不算：内部管理后台可以暂不国际化，但要有明确结论。
