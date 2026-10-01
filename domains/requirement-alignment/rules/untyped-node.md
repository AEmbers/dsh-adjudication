---
name: untyped-node
match:
  - "**/trace-node-*.json"
needs-expert-review: true
severity: medium
source: agent-drafted (t19); 尚无专家背书
---

节点没有声明 type，或 type 不在 requirement/plan/design/implementation/case/feedback 之内。失败模式：方向性判断与覆盖判断都依赖类型 —— 不知道该节点是实现还是用例时，「需求是否被实现」这个问题根本无法回答。取证义务：给出节点 ID 与它的全部边。不算：type 声明了但两侧没有边（那是 orphan-node）。
