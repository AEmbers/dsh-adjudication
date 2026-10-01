---
name: partial-failure
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

部分失败不可见：批量操作里一部分成功一部分失败，界面只提示「操作完成」或只提示「失败」。
取证义务：指出该批量动作与它可能的失败粒度。
不算：批量为全有或全无的事务（此时不存在部分失败），除非事务边界不可靠。
