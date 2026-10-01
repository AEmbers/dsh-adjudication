---
name: regulatory-claim-unsourced
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

监管结论没有法条出处：说「必须」「禁止」而引用的是博客。
失败模式：合规依据不成立，风险被低估。
取证义务：给出来源原文与它是否为法规原文/官方公告。
不算：明确标注为「媒体解读」的不算。
