---
name: address-without-base
match:
  - "**/observations/**"
  - "**/*.log"
  - "**/*.json"
needs-expert-review: true
severity: medium
source: agent-drafted
---

地址没有基址：给出偏移却没说模块基址或文件偏移。
失败模式：地址无法定位到任何字节。
取证义务：给出地址/偏移原文并指出缺少基址或映射说明。
不算：同一条记录里已给出基址并保持一致的不算。
