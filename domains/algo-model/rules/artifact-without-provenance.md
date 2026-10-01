---
name: artifact-without-provenance
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

产物没有溯源：权重/检查点没有 hash，无法确认评估的是哪一份模型。
失败模式：评估结果与产物对不上，复现失败后无从定位。
取证义务：给出产物路径/名称的原文并指出没有 hash 或版本号。
不算：有 commit id / 注册表版本且可引用不算。
