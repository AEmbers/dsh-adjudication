---
name: severity-without-reach
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: medium
source: agent-drafted
---

只有严重度没有影响面：记录了 `severity` 却没有 `reach`，于是「多严重」有了、「多少人受影响」没有，损失无法估量。取证义务：给出反馈 ID 与它缺失的字段。不算：这是内部工具反馈、影响面可确定为「仅内部」—— 那应当显式写成 `reach: one`，而不是留空。
