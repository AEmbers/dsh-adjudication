---
name: paywalled-body-unverified
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

付费墙内容只凭标题：正文不可读，结论依据标题或摘要。
失败模式：标题与结论不符却无人发现。
取证义务：给出标题原文，并明确声明正文未取得。
不算：明确标注「仅见标题，未验证正文」的不算。
