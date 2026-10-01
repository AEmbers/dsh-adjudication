---
name: opaque-cross-domain-ref
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: medium
source: agent-drafted (t19); 尚无专家背书
---

ref 的形状不属于任何已知上游域产出的锚点（REF_SHAPES 无匹配）。失败模式：它可能是一个截图文件名、一段散文、或某个新域的私有格式 —— 本域无法消费它，因此既不能确认也不能否定链接有效。取证义务：给出 ref 原文与节点 ID，并指明它像哪个域的格式（若像）。不算：ref 完全缺失（那是 requirement-without-binding）。
