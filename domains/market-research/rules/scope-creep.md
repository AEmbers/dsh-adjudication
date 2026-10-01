---
name: scope-creep
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

范围漂移：问题问的是一个地区/细分，证据来自另一个地区/细分。
失败模式：结论看起来有据，实际不适用。
取证义务：给出问题里的 scope（地区、时间窗、细分）与来源覆盖范围的原文对比。
不算：明确做了外推说明并有据可查的不算。
