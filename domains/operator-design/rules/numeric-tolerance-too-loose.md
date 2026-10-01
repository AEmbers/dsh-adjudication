---
name: numeric-tolerance-too-loose
match:
  - "**/*.py"
  - "**/*.cc"
  - "**/*.cpp"
  - "**/*.cu"
  - "**/*.cuh"
  - "**/*.h"
  - "**/*.hpp"
  - "**/*.c"
  - "**/*.rs"
  - "**/*.go"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.ml"
  - "**/*.swift"
  - "**/*.ts"
  - "**/*.js"
needs-expert-review: true
severity: high
title: 数值容差过松掩盖错误
source: agent-drafted
---
数值测试的容差大到连量级错误都能通过（例如绝对容差 1e-2 用于量级 1e-4 的量），回归无法被捕获。
必须指出该容差与它相对被测量的量级。
不算：以累积误差为被测对象的迭代算法（此时应说明误差随迭代步数的增长界）。
