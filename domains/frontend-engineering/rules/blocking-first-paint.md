---
name: blocking-first-paint
match:
  - **/*.ts
  - **/*.tsx
  - **/*.js
  - **/*.html
needs-expert-review: true
title: 阻塞首屏
severity: high
source: agent-drafted (t8); 尚无专家背书
---
是否有同步阻塞首屏的脚本、字体、大图或同步 XHR。

失败模式：首屏等一个同步加载的埋点脚本。

取证义务：指出阻塞点与它的加载方式。

不算：defer/async 的脚本不阻塞解析，但可能影响交互，需要分别说明。
