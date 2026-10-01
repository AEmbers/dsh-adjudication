---
name: unrepresentative-sample
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

样本不代表总体：来源集中在某个渠道（比如只有英文媒体、只有一线城市门店）。
失败模式：覆盖面被高估，长尾被忽略。
取证义务：给出各来源的渠道/地区分布（可数），并说明缺失的部分。
不算：明确限定为「某渠道观察」的不算。
