---
name: orphan-decision
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

孤儿决策：这个决策没有 `addresses` 任何反馈，也没有任何反馈的 `closedBy` 指向它。它也许做了别的事，但它与反馈台账无关。取证义务：给出决策 ID、它的标题与状态，并说明它是否出现在任何 `addresses`/`closedBy` 里。不算：决策刚创建、状态是 `planned` —— 那还没有产生闭环是正常的；只有当它声称是 `shipped`/`done` 时才成问题。
