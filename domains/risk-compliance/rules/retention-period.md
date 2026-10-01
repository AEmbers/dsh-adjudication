---
name: retention-period
match:
  - "**"
needs-expert-review: true
severity: high
source: agent-drafted
---

留存期限：未声明保留期限，或声明了期限但没有任何机制按期限清理。
取证义务：引用留存声明原文；若没有声明，指出缺失本身；若有声明，指出缺少的执行机制或超期仍存在的证据。
不算：期限存在且清理任务存在（哪怕调度频率值得商榷）—— 那是另一个更轻的发现。
