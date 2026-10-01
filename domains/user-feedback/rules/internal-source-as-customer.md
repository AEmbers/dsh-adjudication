---
name: internal-source-as-customer
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: low
source: agent-drafted
---

内部来源被当作客户反馈：原话的发出者是内部同事或测试同学，但台账把它按客户反馈的口径计入了影响面。影响面会被系统性高估。取证义务：给出反馈 ID、它的 `source`，以及原话里能看出身份的依据。不算：内部同事实习用户身份报的问题（他们也是用户）—— 那需要在 `source` 里同时记录身份与用户身份，而不是排除。
