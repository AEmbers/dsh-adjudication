---
name: dependency-version
match:
  - **/*.yaml
  - **/*.json
  - **/*.go
needs-expert-review: true
title: 依赖版本
severity: low
source: agent-drafted (t8); 尚无专家背书
---
新增或升级依赖是否引入已知风险或不兼容的主版本。

失败模式：顺手升级主版本，破坏与现有插件的兼容。

取证义务：给出依赖名、旧版本、新版本。

不算：安全补丁升级优先级更高，但仍要说明行为差异。
