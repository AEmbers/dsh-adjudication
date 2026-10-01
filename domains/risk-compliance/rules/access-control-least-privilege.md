---
name: access-control-least-privilege
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

最小权限：角色或服务账号权限过宽（通配资源、管理员角色、跨租户读）。
取证义务：给出具体的授权条目（主体 + 资源 + 动作），并说明它比该主体实际需要多出什么。
不算：宽权限但被独立的能力检查（capability check）在运行时收窄，且该检查确实覆盖所有调用点。
