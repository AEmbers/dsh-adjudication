---
name: resolution-mismatch
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: high
source: agent-drafted
---

闭环理由与决策不符：`closeReason` 描述的处理方式与所指向决策的标题/状态对不上（例如理由是「已加提示文案」而决策是「重构结算页」且状态 `planned`）。闭环被挂在了一个没有做这件事的决策上。取证义务：给出反馈 ID、`closeReason` 原文、决策 ID 与它的标题和状态。不算：决策是父任务、子任务里做了这件事 —— 那要求指出子任务 ID，否则视为不符。
