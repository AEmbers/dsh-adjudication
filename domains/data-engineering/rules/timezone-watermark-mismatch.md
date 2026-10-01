---
name: timezone-watermark-mismatch
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

时区与水位线不一致：事件时间用 UTC、分区键用本地时区，或调度时区与数据时区不同。
失败模式：每天固定漏掉或重复一段时间，且只在跨时区边界出现。
取证义务：给出两个时区各自出现的位置（两段原文），并指出水位线字段。
不算：全链路统一 UTC 且有据可查的不算。
