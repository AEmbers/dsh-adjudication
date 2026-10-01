---
name: test-flakiness
match:
  - "**/*_test.go"
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.test.js"
  - "**/test_*.py"
  - "**/*Test.java"
  - "**/*.spec.ts"
  - "**/*_test.rs"
needs-expert-review: true
severity: medium
source: agent-drafted
---

测试稳定性：依赖真实时间/时区/随机数/外部网络/执行顺序、依赖共享可变状态、断言了不稳定的输出顺序。
不算：已经固定了时间源或注入了随机种子的测试。
