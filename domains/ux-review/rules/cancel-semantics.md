---
name: cancel-semantics
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

取消语义不清：取消后是保留草稿还是丢弃？界面没有说明，且行为与文案不一致。
取证义务：给出取消文案与取消后的实际数据状态。
不算：取消入口不存在（那是更严重的可恢复性问题，应另立发现）。
