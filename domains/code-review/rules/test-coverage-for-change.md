---
name: test-coverage-for-change
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
severity: high
source: agent-drafted
---

变更的测试覆盖：本次改动引入的分支是否有对应的测试；测试是否只断言了「没抛异常」这类空断言；是否存在被 skip/注释掉的测试掩盖了失败。
必须指出未被覆盖的具体分支，而不是笼统地说「测试不够」。
