---
name: baseline-metric-missing
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

baseline 没有同名指标：差值被当成 0 或被默认为「无变化」。
失败模式：拿一个不存在的对照做比较，结论凭空成立。
取证义务：给出实验侧指标行与 baseline 侧缺失该指标的事实，并说明差值为何不存在。
不算：baseline 只声明了部分指标、而结论只覆盖共有指标且有据可查的不算。
