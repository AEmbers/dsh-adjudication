---
name: theme-tag-vs-membership
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

主题两写不一致：反馈记录上的 `theme` 与主题目录里 `members` 列表对不上，一侧有另一侧没有。按主题分捆时会漏掉或多余。取证义务：给出主题 ID、反馈 ID，以及两侧各自的内容。不算：主题目录里根本没有这个主题（`themes` 未收录）—— 那是主题目录缺失，单独成条。
