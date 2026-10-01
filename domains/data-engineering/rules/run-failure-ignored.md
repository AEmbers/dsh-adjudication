---
name: run-failure-ignored
match:
  - "**/dags/**"
  - "**/*.py"
  - "**/*.yml"
  - "**/*.yaml"
needs-expert-review: true
severity: medium
source: agent-drafted
---

失败被忽略：任务设置成失败继续、重试无上限、或告警被关闭。
失败模式：坏数据静默进入下游，直到有人从报表上发现。
取证义务：给出该任务的失败策略配置原文，以及该任务近期的失败记录（runs 里的 status）。
不算：有明确的上游依赖阻断机制且可查的不算。
