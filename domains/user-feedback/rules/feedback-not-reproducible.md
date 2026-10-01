---
name: feedback-not-reproducible
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: medium
source: agent-drafted
---

原话不可复现：原话只有情绪或评价（「太难用了」），没有任何可复现的现象、操作路径或结果。这样的反馈无法被验证，也无法在关闭时说明关掉了什么。取证义务：给出反馈 ID 与原话，并指出它缺少哪一个要素（现象 / 操作 / 结果）。不算：原话虽然简短但给出了具体现象（「导出少一行」）—— 那是可复现的，只是没有给出重现步骤。
