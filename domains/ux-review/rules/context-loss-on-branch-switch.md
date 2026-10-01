---
name: context-loss-on-branch-switch
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

分支切换丢上下文：从错误分支修正后回到主分支，之前的选择被重置。
取证义务：给出切换前后的状态对比证据。
不算：用户主动点击「重新开始」。
