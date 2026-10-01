---
name: feedback-loop-broken
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: medium
source: agent-drafted (t19); 尚无专家背书
---

需求节点没有任何 feedback 入边。失败模式：需求没有可追溯的来源，评审时无法回答「这是谁提的、依据是什么」。取证义务：给出需求 ID 与它的 ref（若存在，说明来源在别的系统）。不算：该需求来自合规或技术债等非用户渠道（应当显式声明来源渠道，而不是留空）。
