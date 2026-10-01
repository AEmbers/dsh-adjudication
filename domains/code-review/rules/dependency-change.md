---
name: dependency-change
match:
  - "**/package.json"
  - "**/go.mod"
  - "**/requirements*.txt"
  - "**/Cargo.toml"
  - "**/pom.xml"
  - "**/*.lock"
  - "**/pnpm-lock.yaml"
needs-expert-review: true
severity: medium
source: agent-drafted
---

依赖变更：新增或升级依赖的来源是否可信、版本约束是否过宽、是否引入与现有依赖重复的库、锁文件与清单是否一致。
不算：补丁级升级且无行为变化的场合（除非变更说明另有暗示）。
