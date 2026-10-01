---
name: string-only-conclusion
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

仅凭字符串下结论：没有交叉引用分析，字符串可能只存在于未使用代码里。
失败模式：把死代码当成功能。
取证义务：给出字符串所在地址/段，并给出引用它的代码位置（或指出该引用未查）。
不算：明确标注为「仅发现字符串，未定位引用」的不算。
