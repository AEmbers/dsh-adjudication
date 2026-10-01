---
name: sample-hash-missing
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

样本没有指纹：产物只有路径，没有 sha256。
失败模式：分析对象与结论对不上，后续无法确认是否同一份产物。
取证义务：给出产物清单原文并指出 hash 缺失。
不算：明确说明产物已失效且无法取得的不算缺陷，只算不可复现。
