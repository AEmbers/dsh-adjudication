---
name: duplicate-binding
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: low
source: agent-drafted (t19); 尚无专家背书
---

两个不同节点绑定同一个 ref。失败模式：同一句原话被登记成两条需求，或实现被复制成两份 —— 后续任何一方更新都会让另一方悄悄过期。取证义务：给出两个节点 ID 与共同 ref。不算：同一节点在不同文档里各有一条记录（那是节点重复，属 node-id-collision）。
