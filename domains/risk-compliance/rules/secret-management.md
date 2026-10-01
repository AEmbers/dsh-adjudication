---
name: secret-management
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

凭据管理：密钥、口令、令牌硬编码在源码、配置或镜像里，或提交进版本库历史。
取证义务：给出凭据所在的具体文件与变量名（值要打码），并说明它的使用点。
不算：测试夹具中的显然假值（example/dummy/placeholder）；本地开发用且已被 .gitignore 覆盖的未提交文件。
