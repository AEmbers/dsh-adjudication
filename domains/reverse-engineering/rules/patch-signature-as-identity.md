---
name: patch-signature-as-identity
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

把特征串当成身份：一段字符串被用来断定实现来源。
失败模式：库被静态链接/二次封装后来源判断错误。
取证义务：给出来源判断原文与依据的字符串/签名，并说明该特征为何可能出现在多处。
不算：明确写成「特征与 X 匹配」而非「就是 X」的不算。
