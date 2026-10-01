---
name: full-table-scan
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

全表扫描：对一张大表做无条件扫描后再 limit，或 order by 无索引列后取前 N。
失败模式：资源竞争导致同集群其他任务超时，根因却指向受害者。
取证义务：给出表名、该表规模证据（schema 注释、runs 里的数据量、或 DDL 原文），以及那一行查询原文。
不算：明确标注为一次性分析任务且已给出规模上界的不算。
