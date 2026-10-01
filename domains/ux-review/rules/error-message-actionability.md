---
name: error-message-actionability
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

错误信息不可行动：只告诉用户「失败了」「出错了」「请重试」，没有说明原因类别、影响范围与下一步动作。
取证义务：引用该错误文案的原文，并指出它缺少三要素中的哪一个。
不算：文案略有歧义但用户仍能自行解决 —— 那是措辞改进，不是缺陷。
