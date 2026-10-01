---
name: ablation-without-control
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

消融缺对照：声称某个组件有效，但没有去掉该组件的对照实验。
失败模式：把整体重训、数据变化或超参调整的效果归给组件。
取证义务：给出实验记录里缺少对照的事实（没有去掉该组件的实验 id），并给出声称该组件贡献的那一行。
不算：已有对照且有据可查的不算。
