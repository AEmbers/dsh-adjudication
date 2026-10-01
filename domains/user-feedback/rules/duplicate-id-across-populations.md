---
name: duplicate-id-across-populations
match:
  - "**/*.json"
needs-expert-review: true
severity: critical
source: agent-drafted
---

跨population重名：同一个字符串既是某条反馈的 ID，又是某个决策（或主题）的 ID。此后任何只写这个 ID 的声明都无法判断指的是哪一个。取证义务：给出这个 ID，并列出它在每个 population 里的位置。不算：反馈 ID 与决策 ID 前缀不同（`fb-` / `dec-`）但尾部数字相同 —— 那是两个不同的 ID。
