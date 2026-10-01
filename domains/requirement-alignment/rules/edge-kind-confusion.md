---
name: edge-kind-confusion
match:
  - "**/trace-derives-*.json"
  - "**/trace-specifies-*.json"
needs-expert-review: true
severity: medium
source: agent-drafted (t19); 尚无专家背书
---

把 `derives`（需求→方案）与 `specifies`（方案→设计）混为一谈。失败模式：两者都表示「由上一层产生」，但 derives 缺了说明方案不是从需求推出来的，specifies 缺了说明设计没有依据 —— 修复责任落在不同的人身上。取证义务：给出边的两端类型与实际的 kind。不算：边不存在（那是 chain-broken）。
