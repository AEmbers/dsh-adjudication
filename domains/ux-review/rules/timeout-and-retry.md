---
name: timeout-and-retry
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

超时无出路：请求超时后没有重试入口，只能退出流程重来。
取证义务：引用超时文案与它提供的唯一动作。
不算：超时后自动重试且给出进度 —— 那是更好的形态。
