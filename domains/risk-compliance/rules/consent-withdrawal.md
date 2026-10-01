---
name: consent-withdrawal
match:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
  - "**/*.kt"
needs-expert-review: true
severity: high
source: agent-drafted
---

同意撤回：用户撤回同意后，处理链路不停（下游仍消费、缓存仍命中、已派生的画像仍在用）。
取证义务：给出撤回入口与至少一个撤回后仍然生效的下游消费点。
不算：仅「撤回入口做得不好用」这类交互问题（那属于 UX 域）；要证明的是处理真的没停。
