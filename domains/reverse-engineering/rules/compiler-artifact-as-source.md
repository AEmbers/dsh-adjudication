---
name: compiler-artifact-as-source
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

把编译器产物当成源码意图：内联/优化后的结构被当成原始设计。
失败模式：结论描述的是编译器，而不是程序。
取证义务：给出被分析的反汇编片段原文与优化等级（或指出未知）。
不算：明确说明「-O2 下内联，结构可能与源码不同」的不算。
