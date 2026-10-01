---
name: cherry-picked-best-run
match:
  - "**/experiments/**"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

择优报告：多次运行里只报了最好的那一次，没有说明选择过程。
失败模式：指标不可复现，且「最好一次」被当成期望性能。
取证义务：给出被报告的那一次运行与其它运行的存在证据（多个实验 id、多条指标），并指出选择规则缺失。
不算：明确写出「报告 N 次运行的中位数/最好值」并有据可查的不算。
