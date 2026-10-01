---
name: back-navigation
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

返回语义不一致：同一流程内既有系统返回又有页面内返回，且两者落到不同位置；或返回会丢失已填内容。
取证义务：给出两条返回路径各自的落点。
不算：确实需要「返回上一步」与「返回首页」两个入口，且标签明确区分。
