---
name: concurrency
match:
  - "**/*.go"
  - "**/*.rs"
  - "**/*.java"
  - "**/*.ts"
  - "**/*.kt"
  - "**/*.cs"
needs-expert-review: true
severity: critical
source: agent-drafted
---

并发：共享可变状态是否受同一把锁保护、goroutine/线程/协程生命周期是否有界、channel/队列有无阻塞或泄漏、取消信号是否被转发到每个子任务。
必须指出具体的共享变量与保护它的那把锁；指不出来就说明你还没有证据。
不算：泛泛的「这里可能有竞态」、缺少基准数据的性能担忧。
