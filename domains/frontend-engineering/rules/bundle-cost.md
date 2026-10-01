---
name: bundle-cost
match:
  - **/*.ts
  - **/*.tsx
  - **/*.js
  - **/*.jsx
  - **/*.json
needs-expert-review: true
title: 体积成本
severity: high
source: agent-drafted (t8); 尚无专家背书
---
新增依赖或大对象是否显著增加产物体积；有 bundle 数据时引用数据，没有数据时标注未知。

失败模式：为一个小功能引入 200KB 的库，首屏变慢。

取证义务：给出体积数据的来源；没有数据就写「未知」，不得断言「不影响首屏」。

不算：构建时被摇树掉的代码不构成运行时成本，但要说明为什么会被摇掉。
