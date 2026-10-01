---
name: reversed-edge
match:
  - "**/trace-derives-*.json"
  - "**/trace-specifies-*.json"
  - "**/trace-implements-*.json"
  - "**/trace-verifies-*.json"
  - "**/trace-informs-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

声明的方向与图上边的方向相反。失败模式：`informs` 是反馈指向需求，写反了就变成「需求由反馈派生」，两者对流程的含义完全相反。取证义务：给出声明方向与图上实际方向，以及两端 ID。不算：两个方向都存在（那是平行边，另立规则）。
