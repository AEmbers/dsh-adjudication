---
name: separation-of-duties
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

职责分离：同一主体既能发起又能审批、既能改配置又能改审计、既能生成又能核销。
取证义务：指出冲突的两个动作及其承担主体，并说明为什么这是不可接受的组合。
不算：小团队临时一人多角色但有补偿性控制（双人复核记录）—— 除非补偿控制不存在。
