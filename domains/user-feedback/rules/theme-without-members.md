---
name: theme-without-members
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: low
source: agent-drafted
---

空主题：主题被声明了，但既没有 `members`，也没有任何反馈把自己的 `theme` 写成它。这个主题名存实亡。取证义务：给出主题 ID 与它的 `name`。不算：主题是刚建的分类骨架、台账里确实还没有属于它的反馈 —— 那标注为「待归入」而不是问题。
