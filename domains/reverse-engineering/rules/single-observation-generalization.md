---
name: single-observation-generalization
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

单次观察过度泛化：一次崩溃被写成「所有输入都会崩溃」。
失败模式：结论外推到未观察的范围。
取证义务：给出那次观察的原文与结论范围，并指出外推缺少样本。
不算：明确限定为「在输入 X 下」的不算。
