---
name: node-id-collision
match:
  - "**/trace-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

同一个节点 ID 被两张图声明，或在同一张图里声明了两次。失败模式：关于它的任何边都无法唯一锚定 —— 「R1→I1 存在」在有两个 R1 时既不是真也不是假。取证义务：给出该 ID 以及所有声明它的文档路径。不算：两个不同 ID 指向同一个 ref（那是重复绑定，另立规则）。
