---
name: resource-timeout-risk
match:
  - "**/dags/**"
  - "**/*.py"
  - "**/*.yml"
  - "**/*.yaml"
needs-expert-review: true
severity: medium
source: agent-drafted
---

资源与超时风险：任务的内存/超时设置与它处理的数据量明显不匹配，或没有设置。
失败模式：间歇性 OOM 被杀，重跑偶发成功，被当作「环境抖动」。
取证义务：给出配置中该任务的资源设置原文，以及数据量或行数证据。
不算：未知数据量时不算缺陷，只能要求补充度量。
