---
name: browser-compat
match:
  - **/*.ts
  - **/*.tsx
  - **/*.js
  - **/*.css
  - **/*.scss
needs-expert-review: true
title: 浏览器兼容
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
新增 API/CSS 特性在目标浏览器上是否可用；是否有降级路径。

失败模式：用了新 API 但目标浏览器没有，功能直接抛错。

取证义务：指出特性与目标浏览器支持情况。

不算：有 polyfill 或特性检测的路径可以接受，但要说明降级行为。
