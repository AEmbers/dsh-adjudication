---
name: dependency-cycle
match:
  - "**/dags/**"
  - "**/*.py"
  - "**/*.yml"
  - "**/*.yaml"
needs-expert-review: true
severity: medium
source: agent-drafted
---

血缘成环：A 依赖 B、B 依赖 A，或通过中间表形成环。
失败模式：调度器永不满足依赖，任务静默不跑。
取证义务：给出环上的节点 id 列表（用 lineage_walk 走出来），并给出每一条边的声明位置。
不算：自环的显式迭代任务（有收敛条件与轮次上限、可引用）不算。
