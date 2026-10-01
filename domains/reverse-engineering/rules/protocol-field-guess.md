---
name: protocol-field-guess
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

协议字段靠猜：字段边界与长度来自试错而非规范或交叉验证。
失败模式：字段解析错误，导致后续所有结论崩塌。
取证义务：给出至少两个能区分该假设的观察（不同输入下的同一偏移），或指出试错样本只有一个。
不算：明确标注为「假设，需更多样本」的不算。
