---
name: implementation-without-case
match:
  - "**/trace-node-*.json"
  - "**/trace-implements-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

实现节点没有任何 verifies 出边 —— 没有被任何用例验证。失败模式：实现被当成已验证，而实际上没有任何可复现的验收步骤；后续回归无从谈起。取证义务：给出实现 ID 与它全部出边的 kind。不算：用例通过 idSpace 以外部 ID 引用（若确实如此，说明验收在别的系统里，需要给出位置）。
