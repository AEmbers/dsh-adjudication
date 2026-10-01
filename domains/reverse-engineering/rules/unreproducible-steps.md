---
name: unreproducible-steps
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

步骤不可复现：缺少样本 hash、工具版本、参数或输入构造方法。
失败模式：同一份记录在别人机器上得出不同结果。
取证义务：给出步骤原文并指出缺失的环节（hash / 版本 / 参数 / 输入来源）。
不算：只做静态阅读（strings/hexdump）且输入 hash 已给出的不算。
