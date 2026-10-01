---
name: speculation-without-marker
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

猜想没有标注：推测性结论与已验证结论混排，读者无法区分。
失败模式：把猜想当事实使用。
取证义务：给出该句原文，并指出它缺少「已验证/未验证」标注。
不算：同一段里已有统一标注（如全段标为推测）的不算。
