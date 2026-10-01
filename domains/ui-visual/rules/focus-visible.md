---
name: focus-visible
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

焦点可见性：outline 被置为 none/0 而没有提供替代的可见焦点样式，或焦点样式对比度低于 3:1。
取证义务：给出被抹掉的 outline 声明与替代样式（若无替代，直接指出）。
不算：用 box-shadow 环替代 outline 且其对比度达标 —— 那是正确做法。
