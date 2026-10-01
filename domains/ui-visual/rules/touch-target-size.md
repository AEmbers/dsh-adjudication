---
name: touch-target-size
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

触控目标过小：可点击区域的命中尺寸小于 44×44（iOS）/ 48×48（Android）。
取证义务：给出该控件的命中尺寸与其所在的尺寸 token（若有）。
不算：视觉尺寸小但已外扩透明命中区达到标准（此时给出命中区证据即可）。
