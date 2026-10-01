---
name: encryption-in-transit
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

传输加密：外部或跨信任域传输未使用 TLS，或校验被关闭（InsecureSkipVerify、rejectUnauthorized:false、verify=False）。
取证义务：给出连接建立点与关闭校验的具体配置行原文。
不算：同主机 loopback 通信；已由服务网格强制 mTLS 覆盖且可证明的调用点。
