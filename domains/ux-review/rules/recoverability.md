---
name: recoverability
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

可恢复性：破坏性动作（删除、提交、支付、解绑）没有撤销、没有二次确认、也没有「发生了什么 / 数据还在不在 / 下一步做什么」的说明。
取证义务：给出该步骤的 id 与它声明的 next/onError/onCancel，并指出缺失的那一种出路。
不算：动作可逆但入口藏得深（那是可达性问题，需要另一条发现并给出路径）。
