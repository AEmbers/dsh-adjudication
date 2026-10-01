---
name: adr-status-superseded-no-replacement
match:
  - "**/*.md"
  - "**/*.mdx"
  - "**/*.rst"
  - "**/*.adoc"
  - "**/adr/**"
  - "**/decisions/**"
needs-expert-review: true
severity: low
title: 作废决策无替代
source: agent-drafted
---
一条 ADR 被标为 superseded，但没有指向任何替代决策，也没有说明作废原因。
必须给出该 ADR 的 id 与它 affects 的模块。
不算：ADR 正文里明确写了「不再需要该约束」的理由。
