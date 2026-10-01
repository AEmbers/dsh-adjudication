---
name: concurrency-in-async
match:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.py"
  - "**/*.kt"
needs-expert-review: true
severity: high
source: agent-drafted
---

异步时序：未 await 的 Promise/Future、并发写同一变量造成的交错、回调与 Promise 混用、在 await 之后使用了已失效的引用（token、连接、请求上下文）。
必须指出未被等待的那次调用、或交错发生的两个执行流。
