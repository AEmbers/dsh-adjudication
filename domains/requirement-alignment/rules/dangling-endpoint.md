---
name: dangling-endpoint
match:
  - "**/trace-*.json"
needs-expert-review: true
severity: high
source: agent-drafted (t19); 尚无专家背书
---

某条边的端点在图上没有节点记录，也不在 idSpace 里 —— 断链。失败模式：链接建立时目标存在，后来被改名或删除，边留了下来。取证义务：给出边的 from/to/kind 与缺失的那一端；并明确指出缺失的是起点还是终点（这两个的修法完全不同）。不算：端点在 idSpace 里声明为外部产物（合法外部依赖）。
