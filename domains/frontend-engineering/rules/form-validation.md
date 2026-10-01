---
name: form-validation
match:
  - **/*.tsx
  - **/*.jsx
  - **/*.vue
  - **/*.ts
needs-expert-review: true
title: 表单校验
severity: high
source: agent-drafted (t8); 尚无专家背书
---
校验是否只在提交时做；错误提示是否可被屏幕阅读器读到；重复提交是否被阻止。

失败模式：只靠高亮边框提示错误，视障用户无法知道哪里错了。

取证义务：指出校验时机与错误提示的关联方式。

不算：服务端校验是必要的，但客户端校验不能因此缺席。
