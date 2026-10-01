---
name: unregistered-reference
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

失效链接：台账的某条链接引用了一个 ID，而这个 ID 在 `feedback`、`decisions`、`themes` 里都没有登记。链接指向空气。取证义务：给出被引用的 ID、引用它的 ID、以及链接的方向（`addresses` 还是 `closedBy`）。不算：被引用的 ID 是外部系统的工单号且台账里有 `externalIds` 映射 —— 那是有意的外部引用。
