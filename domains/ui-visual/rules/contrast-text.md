---
name: contrast-text
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

正文文本对比度：小于 18.66px 常规字重（或小于 24px 任意字重）的文本，其前景与背景的 WCAG 对比度低于 4.5:1。
取证义务：给出前景色、背景色、**计算出的比值**与阈值 4.5:1。没有数字的对比度结论不是发现。
不算：比值刚好不低于 4.5:1；或文本属于装饰性内容且不承载信息。
