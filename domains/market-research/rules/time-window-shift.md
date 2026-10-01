---
name: time-window-shift
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

时间窗口不一致：两个数字覆盖的季度/年度不同却并列比较。
失败模式：把季节性当成趋势。
取证义务：给出两处时间窗原文并指出它们不同。
不算：明确说明窗口差异并就同一窗口做归一的不算。
