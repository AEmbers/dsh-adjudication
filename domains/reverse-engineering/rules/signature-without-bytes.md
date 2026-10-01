---
name: signature-without-bytes
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

结论没有字节依据：说是某种结构/算法，却没有给出对应的字节序列。
失败模式：结论无法被任何人独立验证。
取证义务：给出结论原文与它声称的字节偏移处的十六进制（可引用数据块原文）。
不算：明确标注为「基于字符串推测」的不算。
