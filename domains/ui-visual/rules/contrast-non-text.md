---
name: contrast-non-text
match:
  - "**"
needs-expert-review: true
severity: medium
source: agent-drafted
---

非文本对比度：图标、输入框边框、开关、图表数据线的对比度低于 3:1，导致控件边界不可辨认。
取证义务：给出计算出的比值与 3:1 阈值，并指出该元素承担的功能边界。
不算：纯装饰性分隔线；元素边界由其他可感知方式（如填充色块）明确表达。
