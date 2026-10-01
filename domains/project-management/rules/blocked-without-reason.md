---
name: blocked-without-reason
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

阻塞无因：任务状态为 blocked，但没有任何记录说明被什么阻塞。没有原因的 blocked 在周会上无法被推动，也无法被解除。取证义务：给出任务 ID，并说明依赖边与风险条目里都没有对应的阻塞源。不算：任务的某条依赖边指向状态非 done 的任务（那是可推断的阻塞源，仍需显式确认）。

