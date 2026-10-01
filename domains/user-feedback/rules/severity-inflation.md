---
name: severity-inflation
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

严重度与原文不符：`severity` 标为高危/阻断，但原话描述的只是一个观感或文案问题，没有任何功能失效或数据损失的描述。严重度是排序的输入，凭空拔高会让真正的高损项失去位置。取证义务：给出反馈 ID、它的 `severity`，以及原话中支持或不支持该定级的句子。不算：原话简短但描述的是「钱算错了」这类结果性损失 —— 简短不等于轻微。
