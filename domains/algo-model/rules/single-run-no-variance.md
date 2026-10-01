---
name: single-run-no-variance
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

单次运行就下结论：没有多种子、没有置信区间、没有方差。
失败模式：把噪声当成改进，复现时消失。
取证义务：给出该实验的 seed 与运行次数证据（同 seed 多次运行、或多 seed 序列），并指出声明里没有任何离散度信息。
不算：差异远大于已知噪声且有度量证据的不算；明确标注为「单次观测、待复现」的不算缺陷，只算风险。
