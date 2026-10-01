---
name: cartesian-join
match:
  - "**/*.sql"
  - "**/models/**/*.sql"
  - "**/dags/**/*.sql"
needs-expert-review: true
severity: medium
source: agent-drafted
---

笛卡尔积：join 条件缺失、写在 where 里被外层括号吃掉、或等值键两侧类型不一致导致隐式不匹配。
失败模式：行数爆炸，任务成功但结果错得离谱。
取证义务：给出 join 那一行原文与两侧的表名，并说明连接键为何不成立。
不算：cross join 一个只有一行/一行的日历维表（有证据）不算。
