---
name: a11y-semantics
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
  - **/*.html
  - **/*.svelte
needs-expert-review: true
title: 语义正确
severity: high
source: agent-drafted (t8); 尚无专家背书
---
可交互元素必须使用语义标签（button/a/input），不得用 div+onClick 冒充。

失败模式：屏幕阅读器读不出「这是一个按钮」，键盘也无法聚焦。

取证义务：指出被冒充的语义与应使用的标签。

不算：明确设置了 role、tabIndex、键盘事件且经测试的组件可以接受，但要说明测试方式。
