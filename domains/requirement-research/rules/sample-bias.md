---
name: sample-bias
match:
  - sessions/**
needs-expert-review: true
title: 样本偏差
severity: high
source: agent-drafted (t8); 尚无专家背书
---
当前语料覆盖了哪些角色、场景、时间窗，明显缺失哪些。缺失本身就是一条发现。

失败模式：用 3 位运营的访谈得出「所有用户都」的结论。

取证义务：给出按角色的句数与场次数（session_index 工具），并列出未被覆盖的角色。

不算：「我们接触不到那类用户」不是缺失分析，只是困难陈述。
