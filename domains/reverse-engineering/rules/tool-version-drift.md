---
name: tool-version-drift
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

工具版本未记录：反汇编器/解包器版本会影响输出。
失败模式：指令解码不同，结论无法复现。
取证义务：给出命令原文与工具版本缺失的事实。
不算：使用文件格式规范（版本无关）的不算。
