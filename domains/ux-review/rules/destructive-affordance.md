---
name: destructive-affordance
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

破坏性动作的视觉/交互权重过低：删除与保存使用同一位置、同一颜色、同一默认焦点；或危险按钮是默认回车目标。
取证义务：给出两个动作的图层/位置证据，说明为什么容易误触。
不算：仅颜色不同（那是设计系统一致性问题，属于 UI 视觉域）。
