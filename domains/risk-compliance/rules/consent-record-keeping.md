---
name: consent-record-keeping
match:
  - "**/*.sql"
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
needs-expert-review: true
severity: medium
source: agent-drafted
---

同意记录：无法证明同意是何时、以何种文本、由谁给出的（缺时间戳、版本、文本快照、撤回记录）。
取证义务：给出现有记录的字段集，并指出缺失的要素。
不算：记录齐全但查询界面不好用。
