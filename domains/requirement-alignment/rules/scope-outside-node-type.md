---
name: scope-outside-node-type
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: low
source: agent-drafted (t19); 尚无专家背书
---

节点 type 不在本域词表内，或该节点属于别的域的关注面（例如把构建产物登记成 implementation）。失败模式：类型错了会让覆盖判断整体错位 —— 用产物冒充当实现，覆盖率会虚高。取证义务：给出节点 ID、声明的 type、以及它的 ref 指向哪个域。不算：type 缺失（那是 untyped-node）。
