---
name: currency-and-unit-mix
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

币种与单位混用：美元/人民币、百万/十亿、年度/季度不加说明地并列。
失败模式：量级错十倍，且看起来有出处。
取证义务：给出两处数字原文与各自的单位/币种，并指出换算关系缺失。
不算：明确标注币种与汇率时点的不算。
