---
name: form-validation-timing
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

校验时机错误：只在提交时一次性报错，或在用户还没输完时就报「格式错误」。
取证义务：给出触发校验的事件与提示出现的位置。
不算：实时校验但只做正向提示（「密码强度：强」）—— 那不是阻断式报错。
