---
name: dark-mode-parity
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

深色模式不完整：某组件的颜色在深色模式下仍使用浅色 token，或深色模式下对比度不达标。
取证义务：给出该组件在两种模式下的取值；对比度类必须给出两个模式各自的比值。
不算：刻意在深色模式中保留的反色品牌色块，且其对比度达标。
