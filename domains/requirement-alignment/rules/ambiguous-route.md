---
name: ambiguous-route
match:
  - "**/trace-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

同一对端点之间存在多条路径。失败模式：声明「R1 走到了 I1」时若有两条例外路径，这条发现的读法不唯一 —— 它可能走的是已经废弃的那条。取证义务：列出全部路径（工具 chain_routes 给出）。不算：多条路径共享全部中间节点（那是同一条链的不同记法）。
