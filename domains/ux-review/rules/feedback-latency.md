---
name: feedback-latency
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

反馈与延迟：超过 1 秒的操作没有进行中反馈；超过 10 秒没有可取消或后台化的出路；重复提交没有防抖。
取证义务：给出该步骤与其预期的耗时依据（接口、导出、上传等），并指出当前没有任何反馈。
不算：本地即时操作（切换 tab、展开折叠）—— 它们本来就不需要反馈。
