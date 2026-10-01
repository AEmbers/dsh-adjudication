---
name: encryption-at-rest
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

静态加密：敏感字段落库未加密，或加密密钥与数据同库同权限。
取证义务：指出字段、存储位置与密钥位置；「同库同权限」必须给出两份权限配置。
不算：整库透明加密（TDE）已覆盖且密钥由独立 KMS 管理。
