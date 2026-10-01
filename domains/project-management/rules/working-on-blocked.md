---
name: working-on-blocked
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: medium
source: agent-drafted
---

阻塞中仍在进行：任务状态为 doing，同时它的某条 dependsOn 指向状态不是 done 的任务。
计划里写着「正在做」，图上写着「做不了」——两者不能同时为真，必须有一边是错的。
必须给出：任务 id、被指向的任务 id 与它的状态。
**不算**：被指向的任务状态是 done（前置已完成，doing 是正常的）。
**不算**：任务状态是 blocked（那是显式声明了阻塞，属于 blocked-without-reason 或 blocked-by-not-dependency 的范畴）。
**不算**：依赖边指向的是外部 ID 且该 ID 已在 idSpace 里说明已交付。