---
name: sample-provenance-chain-missing
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

取证链条断裂：中间产物（解包目录、dump）没有记录生成方式。
失败模式：无法回到原始样本，结论不可复核。
取证义务：给出每一步产物的生成命令或指出缺失环节。
不算：单步分析（直接读原始样本）且有 hash 的不算。
