---
name: truncation-overflow
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

截断与溢出：长文本没有明确的截断策略（省略/换行/滚动），或截断后丢失了必要信息且无查看入口。
取证义务：给出该文本容器与它实际的溢出行为。
不算：截断且提供 tooltip/展开入口 —— 那是合规的降级。
