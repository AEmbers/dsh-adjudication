---
name: css-scope
match:
  - **/*.css
  - **/*.scss
  - **/*.less
  - **/*.vue
  - **/*.tsx
needs-expert-review: true
title: 样式隔离
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
新增样式是否可能外溢到其他组件；选择器是否依赖了易变的 DOM 结构。

失败模式：一个 .title 类覆盖了全局所有标题。

取证义务：指出选择器的作用范围。

不算：有命名空间约定的项目可以放宽，但约定要能被引用。
