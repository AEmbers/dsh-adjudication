---
name: duplicate-id-across-documents
match:
  - "**/*.json"
needs-expert-review: true
severity: high
source: agent-drafted
---

跨文档重复 ID：同一个反馈 ID 出现在两份台账文档里。两份记录可能不一致，而按 ID 查询会静默取到其中一份。取证义务：给出该 ID 与两份文档的路径，并指出两份记录在哪些字段上不同。不算：同一份文档里 ID 出现两次且内容完全相同 —— 那是导出工具的重复行，标为数据质量问题而非本规则。
