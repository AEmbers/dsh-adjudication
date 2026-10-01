---
name: missing-baseline
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

没有 baseline：实验声明了提升，但没有任何可比对象。
失败模式：无法判断提升来自改动还是随机波动，结论不可证伪。
取证义务：给出该实验记录里 baseline 缺失的事实（'baseline = (none)' 那一行）与声称提升的那一行。
不算：绝对值指标（如延迟、成本）有明确目标值且有据可查的不算；探索性实验明确声明「不构成结论」不算。
