---
name: vendor-and-subprocessor-register
match:
  - "**/*.md"
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
needs-expert-review: true
severity: medium
source: agent-drafted
---

处理者清单：引入了新的数据接收方（云服务、分析、客服、风控），但处理者清单与隐私政策未同步更新。
取证义务：给出清单现状与新增接收方的对照。
不算：清单中有条目但描述略旧，实质接收方未变。
