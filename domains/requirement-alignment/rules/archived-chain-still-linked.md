---
name: archived-chain-still-linked
match:
  - "**/trace-*.json"
needs-expert-review: true
severity: medium
source: agent-drafted (t19); 尚无专家背书
---

已归档（archived）的链仍被活跃节点引用。失败模式：实现改了，指向已归档需求的边没删，于是追踪库里的「已覆盖」是假的。取证义务：给出归档文档路径与仍指向它的边。不算：归档只是 gate 的排除条件（被排除的候选不在本轮评审范围内，但「仍被引用」这件事需要单独记录）。
