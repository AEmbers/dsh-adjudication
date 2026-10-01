---
name: handoff-unowned
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

跨团队交接无双方确认：一条依赖边跨团队（from 与 to 的 team 不同）且两端没有登记确认。跨团队边是最容易掉的一类，因为两边都以为对方在做。给出边的两端任务 ID 与各自团队。不算：边的一端是外部 ID 且已在 idSpace 里标注交付方式。

