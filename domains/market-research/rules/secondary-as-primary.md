---
name: secondary-as-primary
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

二手材料被当成一手证据：引用分析师的转述、新闻的转述，当作原始数据。
失败模式：误差在转述链条里被放大，且注释里看不出来。
取证义务：给出那段文字与它实际的上游（原始报告/数据集），并说明中间转述了几手。
不算：明确标注「转述自 X」且有据可查的不算。
