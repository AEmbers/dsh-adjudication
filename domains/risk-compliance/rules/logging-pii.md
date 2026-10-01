---
name: logging-pii
match:
  - "**/*.ts"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
  - "**/*.sql"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.json"
needs-expert-review: true
severity: high
source: agent-drafted
---

日志中的个人信息：明文记录身份证、手机号、邮箱、地址、银行卡、生物特征、病历等，或把完整请求体/响应体写进日志。
取证义务：给出具体的日志语句与它会落盘的字段；只写字段名不够，要指出该字段的来源值。
不算：已脱敏（掩码/哈希）且不可逆的字段；日志里只有内部不可反查的 ID。
