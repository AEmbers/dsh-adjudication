---
name: rtl-safe-layout
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

RTL 不安全：使用左/右物理属性而非 start/end 逻辑属性，或图标方向在 RTL 下未镜像。
取证义务：给出该物理属性声明与它在 RTL 下的错误表现。
不算：图标本身无方向语义（如圆形头像）。
