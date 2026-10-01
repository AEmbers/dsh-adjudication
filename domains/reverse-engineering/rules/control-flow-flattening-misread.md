---
name: control-flow-flattening-misread
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

控制流平坦化被误读：把分发器当成业务逻辑。
失败模式：把混淆结构写成程序行为。
取证义务：给出分发器片段原文，并说明为何它是混淆而非业务逻辑（状态变量、映射表）。
不算：明确标注「疑似混淆，未还原」的不算。
