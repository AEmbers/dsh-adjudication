---
name: orphan-node
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

节点在图上既没有入边也没有出边。失败模式：它可能是真的独立（合法），也可能是本该接上去的那条边漏登了 —— 两种情况在图上长得一样，所以必须报告而不是跳过。取证义务：给出节点 ID、type、以及它是否出现在任何里程碑/覆盖清单里。不算：节点只在 idSpace 里（那不是节点记录）。
