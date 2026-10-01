---
name: binary-diff-without-alignment
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

二进制比较没有对齐：直接 diff 两个固件/二进制并据此下结论。
失败模式：地址漂移导致满屏差异，结论无意义。
取证义务：给出对齐方法（基址、函数级匹配、相似度阈值）与比较工具原文。
不算：明确说明「仅做字节级对比、未对齐」的不算缺陷，只算方法限制。
