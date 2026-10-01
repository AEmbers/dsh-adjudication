---
name: seed-sensitivity
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

种子敏感：结论依赖某个 seed，换种子即反转。
失败模式：报告里只出现最好的那个种子，复现时被质疑。
取证义务：给出 seed 那一行原文，并给出至少一次不同 seed 的结果（同一实验族内）或明确的「只跑了一个 seed」事实。
不算：明确声明单种子探索、不构成结论的不算。
