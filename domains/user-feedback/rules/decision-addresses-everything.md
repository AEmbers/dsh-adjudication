---
name: decision-addresses-everything
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

决策包罗万象：一个决策的 `addresses` 覆盖了台账里过半的反馈。这类决策通常不是真的处理了每一条，而是被当成了兜底归集，使闭环数据失去分辨力。取证义务：给出决策 ID、它声明的条数、以及台账反馈总数。不算：系统迁移或统一修复确实一次解决了大量同源问题 —— 那要求这些反馈属于同一主题，给出主题证据即可。
