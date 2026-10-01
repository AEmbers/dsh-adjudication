---
name: error-swallowing
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 错误被吞
severity: high
source: agent-drafted (t8); 尚无专家背书
---
错误是否被忽略、降级为 nil/默认值、或包装后丢失原因。

失败模式：解析失败返回默认配置，服务带着错误配置继续跑。

取证义务：指出被吞掉的具体错误。

不算：有意降级且附带告警的路径可以接受，但告警必须存在。
