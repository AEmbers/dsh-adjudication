---
name: stale-cross-domain-ref
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

节点引用的上游锚点已经不在 upstream[] 的产出集合里 —— 失效链接。失败模式：上游改了标识或删了产物，这边还挂着一个指向不存在对象的指针，链路看起来是通的。取证义务：给出 ref 原文、产出它的域、以及 upstream[] 里同域仍在产出的锚点样例（若一个都没有，说明是整域不在场而不是单条失效）。不算：语料没有声明 upstream[] —— 那种情况下这个问题**无法回答**，只能标未回答，不得默认有效。
