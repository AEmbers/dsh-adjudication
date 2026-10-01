---
name: rate-limiting-and-abuse
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

滥用防护：敏感端点（登录、验证码、找回口令、导出、枚举查询）缺少频率限制或锁定策略。
取证义务：给出端点与当前限制（若完全没有，指出缺失本身）。
不算：内部管理端点已有网络层 ACL —— 除非 ACL 允许任意员工访问。
