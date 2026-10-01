---
name: test-data-in-production-dag
match:
  - "**/dags/**"
  - "**/*.py"
  - "**/*.yml"
  - "**/*.yaml"
needs-expert-review: true
severity: medium
source: agent-drafted
---

测试数据进入生产 DAG：fixture 表、临时 schema、debug 输出被声明在正式血缘里。
失败模式：生产报表混入测试数据，且因为图上看不出而无从排查。
取证义务：给出该节点 id 与声明 test/fixture/tmp 的那一行原文。
不算：明确标记为 sandbox 且不在正式 DAG 里（有调度证据）的不算。
