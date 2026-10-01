---
name: dependency-cycle
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: critical
source: agent-drafted
---

依赖环：A 等待 B、B 等待 C、C 又等待 A —— 环上的任何任务都不会开始，而且每个负责人都在等别人。取证义务：给出**完整的环路径**（T1→T2→T3→T1），不能只说「存在循环依赖」。环必须真的存在：把环的每条边都在图上核对一遍。不算：两条路径都能到同一个节点但不成环（那是菱形依赖，不是环）。

