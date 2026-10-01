---
name: secrets-in-config
match:
  - **/*.yaml
  - **/*.yml
  - **/*.ts
  - **/*.go
  - **/*.py
  - **/*.json
needs-expert-review: true
title: 凭据不落码
severity: critical
source: agent-drafted (t8); 尚无专家背书
---
新增配置是否把凭据写进仓库或默认值。

失败模式：把测试环境的 token 打进默认值，上线后成为后门。

取证义务：给出凭据来源（密钥管理/环境变量）而非字面值。

不算：本地开发用的占位值可以留，但必须明显不可用且不在默认路径生效。
