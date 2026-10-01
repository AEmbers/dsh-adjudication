---
name: timestamp-timezone-drift
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

时间戳口径不清：把文件时间/编译时间当运行时间。
失败模式：事件顺序判断错误。
取证义务：给出时间字段的原文与它的含义来源（构建时间 vs 运行时间）。
不算：明确标注为「构建时间」的不算。
