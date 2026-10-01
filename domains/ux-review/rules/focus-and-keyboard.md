---
name: focus-and-keyboard
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

键盘与焦点：流程无法仅用键盘完成；弹窗打开后焦点没有进入弹窗，关闭后没有回到触发元素。
取证义务：给出无法到达的那一步与它的焦点路径。
不算：纯手势产品（画板、地图）—— 那需要另一套可达性论证。
