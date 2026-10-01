---
name: retry-amplification
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 重试放大
severity: high
source: agent-drafted (t8); 尚无专家背书
---
重试是否可能放大故障（重试风暴、无抖动退避、重试非幂等操作）。

失败模式：下游抖动时重试把 QPS 放大三倍，直接把下游打死。

取证义务：给出行数级的具体重试参数。

不算：由基础设施统一注入的重试策略要单独分析，不能默认它不存在。
