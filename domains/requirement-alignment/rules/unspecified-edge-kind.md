---
name: unspecified-edge-kind
match:
  - "**/trace-*.json"
needs-expert-review: true
severity: medium
source: agent-drafted (t19); 尚无专家背书
---

边没有声明 kind。失败模式：关系类型未知时，「这条边证明了什么」无法判断；把它当成任意一种 kind 使用，等于替作者猜。取证义务：给出 from/to 与两端类型（类型往往能提示它应该是哪一种）。不算：kind 声明了但不在词表内（那是 vocabulary-drift）。
