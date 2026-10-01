---
name: quote-without-record
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

引文不唯一：这段文字在台账的多条反馈原话里都逐字出现，而声明没有给出 `feedbackId`。引文本身不能确定说的是哪一条。取证义务：列出所有逐字包含该片段的反馈 ID。不算：其中一条是另一条的完全重复粘贴且台账已标 `duplicate` —— 那是同一件事的两条记录，按合并后的那条报。
