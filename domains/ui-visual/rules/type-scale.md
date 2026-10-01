---
name: type-scale
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

字号脱离字阶：字号不在既定字阶上（如 15px、17px、23px）。
取证义务：给出该字号与其语义角色（标题/正文/辅助），以及应为的 font-size token。
不算：响应式夹值（clamp/vw）产生的中间字号，其上下界都来自字阶。
