---
name: duplicate-submission
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

重复提交：提交按钮在请求返回前保持可点击，且没有幂等提示。
取证义务：给出按钮状态与其守卫条件。
不算：后端幂等键已保证只生效一次 —— 但界面仍可能显示两条记录，那需要另行取证。
