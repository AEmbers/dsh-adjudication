---
name: decryption-claim-unverified
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

解密/绕过结论未验证：声称可以解出明文，但没有给出明文与其校验方式。
失败模式：把偶然的字节序列当成成功解密。
取证义务：给出解密输出与可用于验证的已知明文/结构（magic、CRC、schema）。
不算：明确标注「疑似解密成功，未验证」的不算缺陷，只算未验证。
