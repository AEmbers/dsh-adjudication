---
name: requirement-ref-not-verbatim
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

需求节点的 ref 是**转述**而不是上游产出的锚点原文（例如写成「用户希望结账更快」而不是 `sessions/s1/u2`）。失败模式：转述无法被上游重算，锚点就退化成了一句自述 —— 这是本域最容易被绕过的一条。取证义务：给出 ref 原文与它应当指向的上游锚点形状（REF_SHAPES）。不算：ref 是合法锚点但已失效（那是 stale-cross-domain-ref）。
