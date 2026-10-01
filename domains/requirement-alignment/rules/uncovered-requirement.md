---
name: uncovered-requirement
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

需求节点走不到任何 implementation 节点 —— 前向覆盖缺失。失败模式：需求被登记进追踪库，然后没有任何实现承接它，而覆盖率报表只统计「有链接的条目」时它会被算成已覆盖。取证义务：给出需求 ID、它能到达的节点集合、以及图里全部实现节点。不算：图里根本没有实现节点（那说明缺口在整张图上，不是这一条链）。
