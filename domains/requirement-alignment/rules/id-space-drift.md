---
name: id-space-drift
match:
  - "**/trace-*.json"
needs-expert-review: true
severity: low
source: agent-drafted (t19); 尚无专家背书
---

idSpace 中声明的外部 ID 已经没有任何边引用它，或某条边引用的 ID 既不在节点里也不在 idSpace 里。失败模式：前者是历史残留，后者是断链 —— 两者都不该长期存在，但修法不同。取证义务：给出 ID 与它是否出现在任何边上。不算：idSpace 本身为空（那不是漂移，是没有外部依赖）。
