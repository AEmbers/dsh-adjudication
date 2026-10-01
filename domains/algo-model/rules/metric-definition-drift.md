---
name: metric-definition-drift
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

指标定义漂移：同一个指标名在不同实验里的 definition 不同（macro/micro、含不含 padding、阈值口径）。
失败模式：跨实验比较出的「提升」其实是口径变化，结论不可复现。
取证义务：给出两个实验里该指标 definition 的两行原文，并指出它们不同在哪里。
不算：同名同定义不算；口径不同但两边都在同一份注册表里声明并已对齐（需引用）不算。
