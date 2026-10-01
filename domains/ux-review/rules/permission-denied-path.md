---
name: permission-denied-path
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

无权限路径缺失或与错误路径混同：无权限被当成系统错误处理，用户反复重试而不是被告知需要申请。
取证义务：给出该分支下的实际反馈文案与它归属的路径类型。
不算：无权限入口本就不展示（隐藏式权限）—— 除非隐藏规则与后端不一致，那需要后端证据。
