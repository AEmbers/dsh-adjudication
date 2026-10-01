---
name: interruption
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

中断与续接：流程被打断（来电、切后台、超时、刷新、误触返回）后无法回到原位；多步流程不能存草稿。
取证义务：给出被打断的具体步骤与它丢失的状态字段。
不算：单步、无状态的确认弹窗 —— 它没有可丢失的进度。
