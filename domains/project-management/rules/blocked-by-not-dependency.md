---
name: blocked-by-not-dependency
match:
  - "**/*.json"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.md"
  - "**/*.csv"
needs-expert-review: true
severity: medium
source: agent-drafted
---

阻塞标记与依赖边混用：同一对任务之间的关系同时被登记为 dependsOn 与 blockedBy，或 blockedBy 指向一个状态已经是 done 的任务。
前者让任务图出现重复边，下游的分捆与关键路径计算会把同一件事算两遍；后者让「已经解除的阻塞」继续显示为阻塞，团队会为一个不存在的障碍安排工作。

必须给出：任务的 id、两边的登记值、以及被指向任务的实际状态。
**不算**：dependsOn 与 blockedBy 指向不同的任务（那是两条独立的边，各自都要成立）。
**不算**：blockedBy 指向的任务状态是 doing（它确实还没交付，阻塞仍然有效）。
**不算**：只有 blockedBy 没有 dependsOn（这是本域合法的表达方式，缺的是 dependsOn 方向的登记，属于另一条发现）。