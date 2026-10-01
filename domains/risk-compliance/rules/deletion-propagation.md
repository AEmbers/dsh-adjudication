---
name: deletion-propagation
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

删除传播：删除请求未端到端落实 —— 备份、派生数据、搜索索引、日志、数仓副本中仍保留。
取证义务：指出删除路径覆盖到哪里、遗漏了哪一处存储，并给出该存储确实仍持有该数据的证据。
不算：加密后不可解密的备份（属可接受的保留形态），除非密钥也在同一删除范围内。
