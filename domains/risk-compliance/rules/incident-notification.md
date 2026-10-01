---
name: incident-notification
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

事件通知：缺少安全事件/数据泄露的识别与上报路径，或上报时限与监管要求不符（如 72 小时）。
取证义务：引出现有流程文档原文；没有流程的要指出缺失，而不是假定有。
不算：有流程但联系人名单过期 —— 那是一个更轻的、可单独提出的发现。
