---
name: state-completeness
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

状态完整性：列表/表单没有定义加载、空、错误、部分失败、无权限五种状态中的至少一种。
取证义务：指出缺的是哪一种状态，以及该状态在什么分支下会被用户遇到。
不算：只定义了骨架屏但没有明确空态文案 —— 那是更轻的发现，需要单独说明差异。
