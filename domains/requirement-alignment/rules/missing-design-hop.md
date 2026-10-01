---
name: missing-design-hop
match:
  - "**/trace-*.json"
needs-expert-review: true
severity: low
source: agent-drafted (t19); 尚无专家背书
---

链路从需求直接跳到实现，中间没有任何 design 节点。失败模式：不一定是缺陷 —— 小改动可以没有独立设计 —— 但需要显式确认，因为它同时意味着「实现无设计依据」这条问责路径不存在。取证义务：给出跳过的两端 ID 与该链其余环节的类型分布。不算：链路本身不完整（那是 uncovered-requirement 或 dangling-endpoint）。
