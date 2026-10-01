---
name: uncosted-exploration
match:
  - "**/sources/**"
  - "**/*.md"
needs-expert-review: true
severity: medium
source: agent-drafted
---

探索成本无上界而没有声明：报告暗示已经把该问的都问完了。
失败模式：读者以为候选集已枚举完毕，实际只是第一批种子。
取证义务：给出报告里对探索范围的描述，并指出缺少「候选集不可先验枚举、成本无上界」的声明。
不算：明确声明了范围与停止条件的不算。
