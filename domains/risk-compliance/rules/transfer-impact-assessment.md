---
name: transfer-impact-assessment
match:
  - "**/*.md"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

影响评估：高风险处理（大规模画像、自动化决策、敏感数据大规模处理）缺少影响评估记录。
取证义务：指出处理活动与它命中的高风险判据；没有记录即指出缺失。
不算：评估记录存在但结论保守 —— 那是实质内容问题，需要另立发现并说明理由。
