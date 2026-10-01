---
name: feedback-without-requirement
match:
  - "**/trace-informs-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

feedback 节点的 informs 边指向了一个不存在或非 requirement 类型的目标。失败模式：用户反馈被记录了，但没有任何需求承接它 —— 于是它既不会被实现，也不会被显式拒绝。取证义务：给出反馈 ID、它指向的 ID 与目标类型（若存在）。不算：反馈指向需求但该需求已被标记为不做（那需要显式的不做记录）。
