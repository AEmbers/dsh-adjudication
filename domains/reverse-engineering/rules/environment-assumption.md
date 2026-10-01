---
name: environment-assumption
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

环境假设未声明：结论依赖特定架构/操作系统/固件版本。
失败模式：换个环境行为不同，结论失效。
取证义务：给出环境信息（架构、OS、固件版本）或明确指出其缺失。
不算：明确写了「以下结论仅限 x86-64 Linux」的不算。
