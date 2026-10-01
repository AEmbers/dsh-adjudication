---
name: password-and-credential-handling
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

口令处理：使用弱哈希（MD5/SHA1/无盐 SHA256）、可逆存储、明文比较，或口令出现在日志/异常里。
取证义务：给出口令从进入到落库/比较的完整路径与所用算法。
不算：外部身份提供方（OIDC/SAML）托管口令 —— 除非本地又存了一份副本。
