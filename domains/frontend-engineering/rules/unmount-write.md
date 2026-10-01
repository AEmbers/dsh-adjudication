---
name: unmount-write
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
needs-expert-review: true
title: 卸载后写入
severity: high
source: agent-drafted (t8); 尚无专家背书
---
组件卸载后是否还会写状态（setState / 赋值 ref）。

失败模式：快速切换页面时后台请求回来写状态，触发警告或错误渲染。

取证义务：指出写入点与卸载时机的关系。

不算：写的是已卸载组件的局部变量（无副作用）不算问题。
