---
name: state-appearance
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

状态外观缺失：hover / active / focus / disabled / loading / error 六态中至少一态未定义。
取证义务：指出缺的是哪一态，以及该元素在什么交互下会进入这一态。
不算：不可能进入某态的元素（如纯展示文本没有 disabled 态）。
