---
name: keyboard-focus
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
  - **/*.css
  - **/*.scss
needs-expert-review: true
title: 键盘可达与焦点可见
severity: high
source: agent-drafted (t8); 尚无专家背书
---
键盘能否到达所有可交互元素；焦点样式是否被 outline: none 抹掉。

失败模式：自定义下拉框键盘打不开，或聚焦了但看不出在哪。

取证义务：指出焦点管理代码或缺失处。

不算：用 :focus-visible 替代 outline 是合法做法，但要给出可见样式。
