---
name: significance-missing
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

缺显著性：给出的小差异（如 0.001）没有区间、没有检验、没有样本量。
失败模式：把小数点后第三位当成结论，实际在噪声范围内。
取证义务：给出两边的数值与样本量（test 集大小），并说明为何该差异无法与噪声区分。
不算：差异量级明显（有量级论证）的不算；指标是确定性计算（如参数量）的不算。
