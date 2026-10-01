---
name: open-vs-decided
match:
  - plans/**
  - requirements/**
needs-expert-review: true
title: 未决项标注
severity: high
source: agent-drafted (t8); 尚无专家背书
---
尚未决策的内容必须标为「待决策」，不得伪装成已决策。

失败模式：方案里写着「采用 X 架构」，其实还没拍板，下游按 X 开始动工。

取证义务：列出待决策项、决策人与决策期限。

不算：有明确决策记录的事项不在此列。
