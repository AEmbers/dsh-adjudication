---
name: case-without-implementation
match:
  - "**/trace-verifies-*.json"
  - "**/trace-node-*.json"
needs-expert-review: true
severity: medium
source: agent-drafted (t19); 尚无专家背书
---

用例节点没有对应的实现入边，或 verifies 边指向的不是实现节点。失败模式：测试写给了另一件事，或者实现被改名后边指向了别处；两种情况都会让「这条用例在保护什么」失去答案。取证义务：给出用例 ID 与它实际验证的对象。不算：用例验证的是设计或方案（那需要显式说明，属于契约变更）。
