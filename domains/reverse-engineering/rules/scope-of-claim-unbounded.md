---
name: scope-of-claim-unbounded
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

结论范围无边界：从一份样本推出整个产品线的行为。
失败模式：把个案当普遍规律。
取证义务：给出结论原文与样本数量，并指出外推。
不算：明确声明「本结论仅限该样本/该版本」的不算。
