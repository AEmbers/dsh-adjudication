---
name: audit-trail-immutability
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

审计日志不可篡改：审计日志可被同一应用修改或删除，或缺少防篡改机制（只写介质 / 哈希链 / 独立账户）。
取证义务：指出日志的写入方与删除/更新能力，并给出可被同一主体删除的具体路径。
不算：日志可被基础设施管理员删除这类普遍事实 —— 要证明的是应用层具备直接篡改能力。
