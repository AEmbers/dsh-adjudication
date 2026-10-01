---
name: numeric-precision-tolerance
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

数值精度与容差：报告值与记录值有效位不同，或用了不一致的舍入。
失败模式：读者把 0.91 与 0.912 当成同一个数，或把舍入差当成改进。
取证义务：给出记录里的原始数值与报告里被舍入后的数值（两处原文）。
不算：明确标注「保留两位小数」且结论不依赖更细位数的不算。
