---
name: untraceable-implementation
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

实现节点没有任何需求能走到它 —— 反向溯源缺失。失败模式：先写了代码再补需求，或某条 derives 边断了，两种都需要人判断。取证义务：给出实现 ID、它实际能追溯到的最远上游节点。不算：实现节点的 ref 指向一个有效的实现锚点（那说明代码是真的，缺的只是链）。
