---
name: self-dependency
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: high
source: agent-drafted
---

自依赖：任务的 dependsOn 里包含它自己。这是一个单节点环，调度器会永久阻塞它，而在甘特图上它看起来只是「工期紧张」。不算：blockedBy 指向自己且 status 已是 blocked 的显式自锁（那是刻意的挂起，仍需在说明里给理由）。

