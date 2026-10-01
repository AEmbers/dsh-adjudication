---
name: bounded-queue
match:
  - **/*.go
  - **/*.ts
  - **/*.java
  - **/*.py
needs-expert-review: true
title: 队列有界
severity: medium
source: agent-drafted (t8); 尚无专家背书
---
内存队列/缓冲区必须有界，并有明确的满载行为（阻塞、丢弃、还是降级）。

失败模式：无界 channel 在流量峰值时把内存吃光。

取证义务：给出容量与满载策略。

不算：由外部 MQ 承担的背压可以简化描述，但要说明发布失败时的行为。
