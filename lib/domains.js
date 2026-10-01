/**
 * dsh-adjudication — the built-in domain library.
 *
 * Nineteen packs, four families. Each pack is DATA: it answers the seven
 * questions the engine asks, and nothing else.
 *
 *   1. candidateSet — what is being adjudicated, and can it be enumerated
 *                     deterministically? (P0)
 *   2. gate         — which cheap predicate rejects a candidate? (P1)
 *   3. bundleKey    — what makes two candidates cheap to judge together? (P2)
 *   4. rules        — which written norms apply, selected by glob? (P3)
 *   5. anchor       — what piece of text proves a finding is about a real
 *                     thing, and can the engine re-derive it? (P5)
 *   6. criticism    — who independently refutes a finding? (P6)
 *   7. loss         — when evidence is short, do we keep it or drop it? (P6)
 *
 * `rulesStatus: 'starter'` marks a pack whose rule library is a real but
 * minimal seed. The engine, the gate, the anchor and the loss policy are all
 * complete for that pack; only the written norms are thin. This distinction is
 * deliberate — a domain with a strong engine and a thin rule library degrades
 * gracefully, whereas a domain with rich prose and no anchor does not degrade
 * at all, it hallucinates.
 */

/** Shared, reusable gate fragments. */
const DOC_GATE = { exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'] }

/**
 * Loss orientation by domain, stated once and loudly.
 *
 * `precision-first` — a false positive is the expensive error. The reviewer
 *   must not assert what it cannot prove. This is open-code-review's default
 *   and it is right for advisory review.
 *
 * `recall-first` — a miss is the expensive error. The reviewer keeps a finding
 *   unless the evidence positively disproves it. Wrong here means a compliance
 *   breach, an unshipped test, or a silently dropped constraint.
 */
const PRECISION = 'precision-first'
const RECALL = 'recall-first'

export const codeReview = {
  id: 'code-review',
  title: '代码评审',
  category: 'A',
  keywords: ['code', 'review', 'diff', 'pull-request', 'bug', 'refactor'],
  summary: '对变更集做有界评审，逐条锚定到 diff 行。open-code-review 的原始领域，是引擎的基准。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'diff-hunks',
    description: '变更集中的文件与 hunk，经 P1 闸门过滤。小变更短路，不调用规划模型。',
  },
  gate: { ...DOC_GATE, extensions: ['.go', '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.sql', '.sh', '.vue', '.svelte'] },
  bundleKey: 'directory',
  anchor: {
    kind: 'diff-line',
    description: '模型逐字抄写它想评论的新增行，引擎用滑窗在 diff 中定位；失配则跨文件唯一命中才搬，否则标记未锚定并降级。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '独立一轮只做事实核查，只删除 diff 能证明为错的评论。' },
  rules: [
    {
      name: 'error-handling',
      match: ['**/*.go', '**/*.ts', '**/*.js', '**/*.py', '**/*.java'],
      text: '错误处理：被忽略的 error/异常返回值、被吞掉的失败分支、只记日志不返回的失败路径。只有当变更本身引入或改变了该路径时才算；既有代码的既有问题不算。',
    },
    {
      name: 'concurrency',
      match: ['**/*.go', '**/*.rs', '**/*.java', '**/*.ts'],
      text: '并发：共享可变状态是否受同一把锁保护、goroutine/线程生命周期是否有界、channel/队列有无阻塞或泄漏风险、取消信号是否被转发。',
    },
    {
      name: 'resource-lifetime',
      match: ['**/*.go', '**/*.ts', '**/*.py', '**/*.java', '**/*.rs'],
      text: '资源生命周期：文件、连接、事务、订阅、定时器是否在所有路径（含异常路径）被释放；defer/finally 是否覆盖了提前返回。',
    },
    {
      name: 'boundary',
      match: ['**/*'],
      text: '边界与契约：空值、越界、整数溢出、时区与编码、精度损失、API 契约的破坏性变更。',
    },
  ],
  prompt: {
    role: '你是一名资深代码评审者，只对本次变更中的、有证据支持的缺陷给出意见。',
    instruction: '对每条意见，逐字引用新增行作为锚点。证据不足以证明时，不要提出。',
  },
}

export const riskCompliance = {
  id: 'risk-compliance',
  title: '风控合规监察',
  category: 'A',
  keywords: ['risk', 'compliance', 'audit', 'regulation', 'policy', 'gdpr', 'security'],
  summary: '把制度条款当作规则库，对业务/系统行为逐条取证。**默认 recall-first**：漏掉一条合规问题的事故成本远高于误报。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'regulated-surface',
    description: '受监管的行为面：数据流向、权限边、对外接口、留存策略、日志内容。由条款清单反推需要检查的面。',
  },
  gate: { ...DOC_GATE, exclude: [...DOC_GATE.exclude, '**/*.md'] },
  bundleKey: 'regulation',
  anchor: {
    kind: 'clause-and-evidence',
    description: '双锚点：条款 ID（规则侧，由引擎给出）+ 证据原文（受审侧，模型抄写、引擎滑窗定位）。两者缺一不可。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '复核者只删除被证据**正面否定**的发现，保留存疑项并标记为待人工确认。' },
  protectedSubjects: ['security', 'privacy', 'safety', 'data-loss', 'legal'],
  rules: [
    {
      name: 'data-minimisation',
      match: ['**'],
      text: '数据最小化（GDPR Art.5 / 个保法第 6 条）：为达成目的所必需之外的个人信息收集、存储、传输，即为问题。逐项指出「必要性缺失」的证据。',
    },
    {
      name: 'cross-border',
      match: ['**'],
      text: '数据传输：个人数据出境是否有合法性基础与合同工具；是否存在未申报的境外接收方或第三方 SDK 回传。',
    },
    {
      name: 'retention',
      match: ['**'],
      text: '留存与删除：是否声明保留期限；是否支持删除请求的端到端落实（含备份、派生数据、日志）。',
    },
    {
      name: 'access-control',
      match: ['**'],
      text: '访问控制：最小权限、职责分离、审计日志的不可篡改性；是否存在越权的隐式信任（内网即可信等）。',
    },
  ],
  prompt: {
    role: '你是合规监察员。你的损失取向是 recall-first：存疑即保留，只有证据正面否定时才删除。',
    instruction: '每条发现必须同时给出条款依据与证据原文。无法给出条款依据的，标记为「待定条款」而不是丢弃。',
  },
}

export const uxReview = {
  id: 'ux-review',
  title: 'UX 交互设计',
  category: 'A',
  keywords: ['ux', 'interaction', 'flow', 'usability', 'figma', 'onboarding'],
  summary: '对交互流程做逐节点的可用性审定。锚点是流程步骤 + 设计稿节点，不是主观感受。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'flow-steps',
    description: '流程的步骤序列及其分支（正常路径、错误路径、中断路径、回退路径、空态、首用态）。分支本身就是候选集的一部分。',
  },
  gate: DOC_GATE,
  bundleKey: 'flow',
  anchor: {
    kind: 'flow-step-and-node',
    description: '锚点是「流程步骤编号 + 设计稿节点名」。模型必须同时给出两者，引擎校验步骤确实存在于该分支、节点确实存在于该稿。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '只删除流程里不存在的步骤或不存在的节点所支撑的评论。' },
  rules: [
    {
      name: 'recoverability',
      match: ['**'],
      text: '可恢复性：每一个破坏性动作是否可撤销或可确认；错误发生后用户是否知道发生了什么、下一步做什么、数据是否还在。',
    },
    {
      name: 'state-completeness',
      match: ['**'],
      text: '状态完整性：每个列表/表单是否定义了加载、空、错误、部分失败、无权限五种状态；缺失即为问题并指出缺失的是哪一种。',
    },
    {
      name: 'interruption',
      match: ['**'],
      text: '中断与续接：流程被打断（来电、切后台、超时、刷新）后能否回到原位；多步流程是否可保存草稿。',
    },
    {
      name: 'feedback-latency',
      match: ['**'],
      text: '反馈与延迟：超过 1 秒的操作有无进行中反馈；超过 10 秒有无可取消或后台化；重复提交有无防抖。',
    },
  ],
  prompt: {
    role: '你是资深交互设计师，评审的是流程的完备性与可恢复性，不是视觉偏好。',
    instruction: '凡涉及用户感受的判断，必须落到具体步骤与具体后果上，否则不要提出。',
  },
}

export const uiVisual = {
  id: 'ui-visual',
  title: 'UI 视觉设计',
  category: 'A',
  keywords: ['ui', 'visual', 'design-system', 'token', 'accessibility', 'contrast'],
  summary: '对设计系统一致性做审定。锚点是图层 ID + design token 名；一切判断都能落到 token 上。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'layers-and-tokens',
    description: '图层属性（间距、字号、圆角、阴影、色值、层级）与其声明的 token。偏离 token 的硬编码值是主要候选。',
  },
  gate: DOC_GATE,
  bundleKey: 'component',
  anchor: {
    kind: 'layer-and-token',
    description: '锚点是「图层 ID + token 名」。引擎校验该图层存在、该 token 在系统里存在，且当前值是硬编码而非引用。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '只删除与 token 表或图层属性不符的评论。' },
  rules: [
    {
      name: 'token-adherence',
      match: ['**'],
      text: 'Token 一致性：任何硬编码的颜色、间距、字号、圆角都应替换为既有 token。指出硬编码值与应对应的 token 名。',
    },
    {
      name: 'contrast',
      match: ['**'],
      text: '对比度：正文、次要文本、占位符、禁用态、图标在各自背景上的对比度是否达到 WCAG AA（正文 4.5:1，大字号 3:1）。给出计算出的比值。',
    },
    {
      name: 'scale-and-rhythm',
      match: ['**'],
      text: '尺度与节奏：间距是否落在 4/8 栅格上；字号是否来自既定字阶；同类元素在不同页面是否用了不同值。',
    },
    {
      name: 'state-appearance',
      match: ['**'],
      text: '状态外观：hover / active / focus / disabled / loading / error 六态是否都有定义，focus 环是否可见且不被 outline:none 抹掉。',
    },
  ],
  prompt: {
    role: '你是设计系统维护者。你的评审只基于 token 表与图层属性，不评论主观审美。',
    instruction: '每条发现必须给出图层 ID、当前值、应为的 token 名。',
  },
}

export const architecture = {
  id: 'architecture',
  title: '架构设计',
  category: 'A',
  keywords: ['architecture', 'module', 'coupling', 'adr', 'boundary', 'dependency'],
  summary: '对架构决策与模块边界做审定。锚点是模块 ID + ADR 编号，检查的是「决策是否被遵守」。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'modules-and-decisions',
    description: '模块及其依赖边，加上已归档的架构决策记录（ADR）。候选是「边」与「决策」的组合。',
  },
  gate: { ...DOC_GATE, exclude: [...DOC_GATE.exclude, '**/test/**', '**/tests/**', '**/*.spec.*', '**/*.test.*'] },
  bundleKey: 'module',
  anchor: {
    kind: 'module-and-adr',
    description: '锚点是「模块 ID」或「ADR 编号」。声明依赖方向的发现必须能被依赖图验证。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '只删除依赖图中不成立、或 ADR 中无此决策的评论。' },
  rules: [
    {
      name: 'dependency-direction',
      match: ['**'],
      text: '依赖方向：依赖是否指向允许的方向（如外层→内层、业务→基础设施的反向即违规）。指出具体的反向边。',
    },
    {
      name: 'cycle',
      match: ['**'],
      text: '环依赖：模块间是否形成环。给出环的具体路径，而不是笼统说「耦合高」。',
    },
    {
      name: 'decision-drift',
      match: ['**'],
      text: '决策漂移：实现是否偏离已归档的 ADR。偏离要么是缺陷，要么意味着 ADR 需要被新决策取代——指出是哪一种。',
    },
    {
      name: 'boundary-leak',
      match: ['**'],
      text: '边界泄漏：跨模块直接访问对方内部数据/表/私有类型，绕过既定的接口或事件。',
    },
  ],
  prompt: {
    role: '你是架构评审者，评审的是决策一致性与依赖结构，不是代码风格。',
    instruction: '凡声称违反某决策，必须给出 ADR 编号；凡声称存在反向依赖，必须给出边的两端。',
  },
}

export const dataEngineering = {
  id: 'data-engineering',
  title: '数据工程',
  category: 'A',
  keywords: ['data', 'etl', 'pipeline', 'lineage', 'schema', 'warehouse', 'quality'],
  summary: '对数据管道做审定。锚点是「表.字段 + 血缘节点」。**默认 recall-first**：静默的数据错误比 pipeline 报错危险得多。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'pipeline-nodes',
    description: '管道节点（抽取、转换、加载、调度、校验）及其输入输出表。血缘图的每条边都是候选。',
  },
  gate: { ...DOC_GATE, exclude: [...DOC_GATE.exclude, '**/test/**', '**/tests/**'] },
  bundleKey: 'pipeline',
  anchor: {
    kind: 'table-column-and-node',
    description: '锚点是「schema.table.column + 血缘节点 ID」。引擎校验该字段确实在该节点的输入或输出里。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '只删除被 schema 或血缘正面否定的发现；存疑项保留并标记待人工确认。' },
  rules: [
    {
      name: 'nullability',
      match: ['**/*.sql', '**/*.py', '**/*.yaml', '**/*.yml', '**/*.json'],
      text: '空值与默认：新增字段是否可空、下游是否假设非空；DEFAULT 是否掩盖了上游质量问题；NULL 与空串/%s 语义是否混淆。',
    },
    {
      name: 'idempotency',
      match: ['**'],
      text: '幂等与重跑：任务重跑是否产生重复数据；是否依赖插入顺序或执行时刻；分区覆盖与追加的语义是否明确。',
    },
    {
      name: 'schema-evolution',
      match: ['**'],
      text: 'Schema 演进：字段删除、类型收窄、语义变更是否破坏下游；是否走了向后兼容的加列/双写路径。',
    },
    {
      name: 'timezone-and-late',
      match: ['**'],
      text: '时区与迟到数据：时间戳的时区是否明确；迟到数据是否被丢弃；水位线与窗口口径是否与业务约定一致。',
    },
  ],
  prompt: {
    role: '你是数据平台评审者。你的损失取向是 recall-first：静默的数据正确性问题必须暴露。',
    instruction: '每条发现给出具体的表.字段与血缘节点。无法定位到字段的，降级为待确认而不是丢弃。',
  },
}

export const algoModel = {
  id: 'algo-model',
  title: '算法模型',
  category: 'A',
  keywords: ['algorithm', 'model', 'ml', 'experiment', 'metric', 'training', 'evaluation'],
  summary: '对模型实验与评估做审定。锚点是「指标名 + 实验 ID」。核心是评估口径的可复现性。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'experiments-and-metrics',
    description: '实验配置、数据切分、指标定义、超参、对照基线。候选是「一次实验的一个指标口径」。',
  },
  gate: DOC_GATE,
  bundleKey: 'experiment',
  anchor: {
    kind: 'metric-and-experiment',
    description: '锚点是「指标名 + 实验 ID」。引擎校验该指标确实在该实验中定义、该实验确实存在基线。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '只删除与实验记录不符的评论。' },
  rules: [
    {
      name: 'leakage',
      match: ['**'],
      text: '数据泄漏：训练集与评估集是否重叠；特征是否在预测时刻不可得（未来信息）；标准化/填充是否在全量上拟合后再切分。',
    },
    {
      name: 'baseline',
      match: ['**'],
      text: '基线充分性：对照是什么、是否同预算同数据同调参强度；「比随机好」不构成结论。',
    },
    {
      name: 'metric-definition',
      match: ['**'],
      text: '指标口径：指标的分子分母是否写清楚；是否用了会被类别不均衡欺骗的指标；离线指标与线上目标是否一致。',
    },
    {
      name: 'variance',
      match: ['**'],
      text: '方差与显著性：单次运行的差异是否落在种子波动范围内；有无重复实验或置信区间。',
    },
  ],
  prompt: {
    role: '你是算法评审者，评审的是实验的可复现性与结论的支撑度。',
    instruction: '凡声称指标提升，必须给出基线、数据集与预算；否则不要提出。',
  },
}

export const techTest = {
  id: 'tech-test',
  title: '技术测试',
  category: 'A',
  keywords: ['test', 'qa', 'coverage', 'case', 'regression', 'assertion'],
  summary: '对测试覆盖与用例质量做审定。锚点是「用例 ID + 被覆盖的代码行」。**默认 recall-first**：漏测是不可见风险。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'cases-and-covered-lines',
    description: '用例集与它们实际断言的代码路径。候选是「一条未被任何用例覆盖的分支」。',
  },
  gate: { ...DOC_GATE, exclude: [...DOC_GATE.exclude] },
  bundleKey: 'module',
  anchor: {
    kind: 'case-and-covered-line',
    description: '锚点是「用例 ID + 代码行」。引擎校验该用例存在，且该行确实在其执行路径上。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '只删除被覆盖报告正面否定的发现；存疑的覆盖缺口保留。' },
  rules: [
    {
      name: 'assertion-strength',
      match: ['**'],
      text: '断言强度：用例是否只有「不抛异常」式的弱断言；是否断言了具体值而非仅断言非空；是否在断言前就被 mock 抹平了差异。',
    },
    {
      name: 'branch-coverage',
      match: ['**'],
      text: '分支覆盖：错误分支、边界值（0/1/最大/空）、并发路径是否被覆盖。逐条指出未被覆盖的分支。',
    },
    {
      name: 'flakiness',
      match: ['**'],
      text: '稳定性：用例是否依赖时钟、随机、网络、执行顺序或睡眠；重跑是否能稳定通过。',
    },
    {
      name: 'test-validity',
      match: ['**'],
      text: '用例有效性：断言是否可能因被测代码被删除而依然通过（空跑）；mock 是否把被测逻辑本身也替换掉了。',
    },
  ],
  prompt: {
    role: '你是测试评审者。你的损失取向是 recall-first：未被覆盖的风险必须暴露。',
    instruction: '每条发现给出用例 ID 或明确标注「无用例覆盖」，并指出具体的代码行或分支。',
  },
}

export const techDoc = {
  id: 'tech-doc',
  title: '技术文档',
  category: 'A',
  keywords: ['doc', 'readme', 'api-doc', 'tutorial', 'changelog'],
  summary: '对文档与实现的一致性做审定。锚点是「段落锚 + API 签名」。每处不一致都能被源码验证。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'doc-claims',
    description: '文档中每个可验证的断言（签名、参数、返回、默认值、示例、限制），与对应源码的比对。',
  },
  gate: DOC_GATE,
  bundleKey: 'document',
  anchor: {
    kind: 'section-and-signature',
    description: '锚点是「文档段落锚 + 源码 API 签名」。引擎用滑窗在源码中定位该签名，验证文档描述与之一致。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '只删除源码可证明为正确的文档陈述。' },
  rules: [
    {
      name: 'signature-drift',
      match: ['**/*.md', '**/*.mdx', '**/*.rst'],
      text: '签名漂移：文档中的函数签名、参数名、必填性、默认值、返回类型与源码是否一致。逐项对照。',
    },
    {
      name: 'example-runnable',
      match: ['**/*.md', '**/*.mdx'],
      text: '示例可运行性：示例代码是否引用了不存在的 API、缺少必要 import、使用了已废弃的写法。',
    },
    {
      name: 'stated-limits',
      match: ['**/*.md', '**/*.mdx'],
      text: '限制与边界：文档是否遗漏了实现中真实存在的限制（大小上限、超时、并发度、平台差异）。',
    },
    {
      name: 'link-integrity',
      match: ['**/*.md', '**/*.mdx'],
      text: '链接完整性：相对路径链接是否指向存在的文件；锚点是否指向存在的标题。',
    },
  ],
  prompt: {
    role: '你是技术文档评审者，评审的是文档与实现的一致性，不是文笔。',
    instruction: '每条发现必须给出源码侧的验证点（文件与签名），否则属于风格建议，不要提出。',
  },
}

export const operatorDesign = {
  id: 'operator-design',
  title: '算子设计',
  category: 'A',
  keywords: ['operator', 'kernel', 'numerics', 'gpu', 'tolerance', 'performance'],
  summary: '对算子实现做审定。锚点是「算子签名 + 数值容差」。核心是数值正确性与边界形态。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'operator-implementations',
    description: '算子的每个实现（不同后端、不同 dtype、不同 shape 分支）。一个实现的一个形态就是候选。',
  },
  gate: DOC_GATE,
  bundleKey: 'operator',
  anchor: {
    kind: 'signature-and-tolerance',
    description: '锚点是「算子签名 + 数值容差断言」。引擎校验该签名存在、该容差在测试中被实际断言。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '只删除被数值测试正面否定的发现；未覆盖的形态保留。' },
  rules: [
    {
      name: 'numeric-stability',
      match: ['**/*.cu', '**/*.cpp', '**/*.c', '**/*.py', '**/*.h', '**/*.hpp'],
      text: '数值稳定性：归约的求和顺序、log-sum-exp 等价变换、除零与下溢、累积误差是否随规模增长；是否用了比输入更低的精度做累加。',
    },
    {
      name: 'shape-and-type',
      match: ['**'],
      text: '形态与类型：空张量、单元素、非连续内存、广播、dtype 混合提升、stride 非平凡的情形是否被处理。',
    },
    {
      name: 'tolerance-honesty',
      match: ['**'],
      text: '容差诚实性：测试容差是否被放宽到掩盖真实误差；是否用相对误差在接近零处失去意义。',
    },
    {
      name: 'backend-parity',
      match: ['**'],
      text: '多后端一致性：CPU 与加速后端、不同 dtype 分支的结果是否在声明的容差内一致。',
    },
  ],
  prompt: {
    role: '你是数值算子评审者。你的损失取向是 recall-first：任何未覆盖的形态都是风险。',
    instruction: '每条发现给出算子签名与具体的数值反例或未覆盖形态。',
  },
}

export const requirementResearch = {
  id: 'requirement-research',
  title: '需求调研分析',
  category: 'B',
  keywords: ['requirement', 'research', 'interview', 'user-need', 'discovery'],
  summary: '从原始访谈/反馈中提取需求。**构建型**：先在受约束的抽取器里生成，再走审定型回路。**默认 recall-first**：漏掉一条真实诉求的代价是返工。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'verbatim-quotes',
    description: '原始材料中的每一句用户原话。候选不是「需求」，是「原话」——需求是它的加工产物。',
  },
  gate: { exclude: ['**/node_modules/**', '**/.git/**'] },
  bundleKey: 'interview',
  anchor: {
    kind: 'verbatim-and-timestamp',
    description: '锚点是「原话逐字引用 + 时间戳/受访者 ID」。引擎校验该原话确实出现在语料中；改写过的引用会被退回。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '只删除语料中找不到原话支撑的提取项；存疑的保留并标记待回访确认。' },
  rules: [
    {
      name: 'verbatim-only',
      match: ['**'],
      text: '原话优先：每条需求必须能追溯到逐字原话。禁止把「用户说 A」升格为「用户需要 B」，除非另有原话直接支持 B。',
    },
    {
      name: 'stated-vs-latent',
      match: ['**'],
      text: '显性/潜在：区分用户明说的、和从行为或抱怨中推断的。潜在需求必须标记为推断并给出推断依据，不得与显性需求混排。',
    },
    {
      name: 'sample-bias',
      match: ['**'],
      text: '样本偏差：当前语料覆盖了哪些角色/场景，明显缺失哪些。缺失本身是一条发现。',
    },
    {
      name: 'contradiction',
      match: ['**'],
      text: '冲突保留：不同受访者的相互矛盾诉求必须同时保留并列出，不得自行取平均值或择一。',
    },
  ],
  prompt: {
    role: '你是需求分析师。你的损失取向是 recall-first：宁可保留存疑项交回访确认，不可丢弃。',
    instruction: '每条提取必须给出逐字原话与出处。任何改写都会失去锚点。',
  },
}

export const productPlanning = {
  id: 'product-planning',
  title: '产品规划经理',
  category: 'B',
  keywords: ['product', 'planning', 'roadmap', 'priority', 'okr', 'spec'],
  summary: '把已确认的需求编排成受约束的方案。锚点是「需求 ID + 目标指标」——每条方案都必须挂回一条需求。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'requirement-to-plan-links',
    description: '每条需求与它被分配到的方案项之间的边。孤儿需求与孤儿方案是主要候选。',
  },
  gate: { exclude: ['**/node_modules/**', '**/.git/**'] },
  bundleKey: 'release',
  anchor: {
    kind: 'requirement-and-metric',
    description: '锚点是「需求 ID + 目标指标」。引擎校验需求 ID 存在于需求库、指标有定义与当前基线。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '只删除需求库中不存在的 ID 所支撑的方案项。' },
  rules: [
    {
      name: 'traceability',
      match: ['**'],
      text: '可追溯性：每条方案必须挂到至少一条已确认需求；说不出来源的功能不进方案。未被任何方案承接的需求同样要列出。',
    },
    {
      name: 'measurable',
      match: ['**'],
      text: '可度量：目标必须有指标、基线、时间窗。没有基线的「提升 X%」不成立。',
    },
    {
      name: 'cost-honesty',
      match: ['**'],
      text: '成本诚实：是否给出了依赖、前置条件与不可行风险；是否把未决策项伪装成已决策项。',
    },
    {
      name: 'scope-creep',
      match: ['**'],
      text: '范围蔓延：方案中是否存在无需求来源的附加项；是否有「顺手做」的条目。',
    },
  ],
  prompt: {
    role: '你是产品规划者，评审的是方案与需求的对应关系与可度量性。',
    instruction: '每条方案给出所承接的需求 ID 与目标指标；给不出的，标记为无来源并单独列出。',
  },
}

export const backendEngineering = {
  id: 'backend-engineering',
  title: '后端工程',
  category: 'B',
  keywords: ['backend', 'server', 'api', 'database', 'service', 'microservice'],
  summary: '服务端实现。**构建型**：复用 code-review 的引擎与锚点，另加服务端专属规则与契约检查。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: { kind: 'diff-hunks', description: '与代码评审相同：变更集的 hunk。' },
  gate: { ...DOC_GATE, extensions: ['.go', '.ts', '.js', '.py', '.java', '.kt', '.rs', '.cs', '.rb', '.php', '.sql', '.proto', '.yaml', '.yml'] },
  bundleKey: 'service',
  anchor: { kind: 'diff-line', description: '与代码评审相同：滑窗定位逐字抄写的新增行。', verify: 'engine-recomputable' },
  criticism: { kind: 'fact-checker', description: '只删除 diff 能证明为错的评论。' },
  rules: [
    { name: 'api-contract', match: ['**/*.proto', '**/*.yaml', '**/*.yml', '**/*.ts', '**/*.go', '**/*.java'], text: '接口契约：字段增删是否破坏兼容；可选性标注是否与实现一致；错误码是否复用而非新增；是否有未声明的行为变更。' },
    { name: 'transaction', match: ['**/*.sql', '**/*.go', '**/*.java', '**/*.py', '**/*.ts'], text: '事务与一致性：跨库/跨服务写操作的一致性；是否在事务内做了外部调用；隔离级别是否足以支撑读改写。' },
    { name: 'backpressure', match: ['**'], text: '背压与超时：每个外部调用是否有超时与重试上限；重试是否可能放大故障；队列是否有界。' },
    { name: 'observability', match: ['**'], text: '可观测性：关键路径是否有日志/指标/追踪；失败时能否定位到具体请求。' },
  ],
  prompt: { role: '你是服务端评审者，只对本次变更中有证据的缺陷给出意见。', instruction: '每条意见逐字引用新增行作为锚点。' },
}

export const frontendEngineering = {
  id: 'frontend-engineering',
  title: '前端工程',
  category: 'B',
  keywords: ['frontend', 'web', 'react', 'vue', 'css', 'browser', 'performance'],
  summary: '客户端实现。**构建型**：复用 code-review 引擎，另加渲染、状态与可访问性规则。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: { kind: 'diff-hunks', description: '与代码评审相同：变更集的 hunk。' },
  gate: { ...DOC_GATE, extensions: ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less', '.html', '.json'] },
  bundleKey: 'feature',
  anchor: { kind: 'diff-line', description: '与代码评审相同：滑窗定位逐字抄写的新增行。', verify: 'engine-recomputable' },
  criticism: { kind: 'fact-checker', description: '只删除 diff 能证明为错的评论。' },
  rules: [
    { name: 'render-correctness', match: ['**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.svelte'], text: '渲染正确性：副作用是否在渲染期执行；依赖数组是否完整；是否以可变对象作为依赖；列表 key 是否稳定。' },
    { name: 'async-race', match: ['**'], text: '异步竞态：请求返回顺序是否被假设；组件卸载后是否还会 setState；是否有真正的取消。' },
    { name: 'a11y', match: ['**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.html'], text: '可访问性：可交互元素是否语义正确（div 当按钮用即为问题）；是否有键盘可达与可见焦点；图片是否有替代文本。' },
    { name: 'bundle-cost', match: ['**'], text: '体积成本：是否引入了可观的依赖；是否阻塞首屏；是否可用动态导入。给出粗略影响。' },
  ],
  prompt: { role: '你是客户端评审者，只对本次变更中有证据的缺陷给出意见。', instruction: '每条意见逐字引用新增行作为锚点。' },
}

export const marketResearch = {
  id: 'market-research',
  title: '市场调研',
  category: 'C',
  keywords: ['market', 'research', 'competitor', 'survey', 'sizing', 'trend'],
  summary: '**探索型**：候选集本身要找，P0 枚举失效。锚点是「来源 URL + 原文引用」。**默认 recall-first**，且**不承诺低 token**。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'open-corpus',
    description: '候选集不可先验枚举 —— 需要先做一轮「找出候选来源」。这一轮的成本无法承诺上界。',
  },
  gate: { exclude: ['**/node_modules/**', '**/.git/**'] },
  bundleKey: 'source',
  anchor: {
    kind: 'source-url-and-quote',
    description: '锚点是「来源 URL + 原文引用」。引擎无法验证外部网页的内容（可能已变更或需登录），因此锚点的可复核性等级低于 A 类，必须显式标注。',
    verify: 'externally-recheckable',
  },
  criticism: { kind: 'triage', description: '不删除，只标注证据强度（一手/二手/推测）。' },
  rules: [
    { name: 'source-grade', match: ['**'], text: '来源分级：一手（官方披露、原始数据）／二手（报道、分析）／推测。每条结论必须标注等级，二手不得当作一手使用。' },
    { name: 'sizing-honesty', match: ['**'], text: '规模估算：TAM/SAM/SOM 的口径与假设必须写出；top-down 与 bottom-up 是否互相印证；不给出无假设的数字。' },
    { name: 'recency', match: ['**'], text: '时效性：数据日期必须标注；超过 18 个月的市场数据不得作为现状结论。' },
    { name: 'survivorship', match: ['**'], text: '幸存者偏差：只统计了成功者、只看了头部玩家的结论必须被标记。' },
  ],
  prompt: { role: '你是市场研究员。你的损失取向是 recall-first：宁可保留低置信线索并标注等级，不可因不确定而丢弃。', instruction: '每条结论给出来源 URL 与原文引用，并标注证据等级。' },
}

export const reverseEngineering = {
  id: 'reverse-engineering',
  title: '逆向工程',
  category: 'C',
  keywords: ['reverse', 'binary', 'protocol', 'disassembly', 'firmware', 'format'],
  summary: '**探索型**：从产物反推设计。锚点是「可复现的观察」——同一输入、同一操作、同一结果。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'observable-behaviours',
    description: '可观测行为（输入输出对、协议交互、文件格式样本）。候选集随探索扩大，不可先验枚举。',
  },
  gate: { exclude: ['**/.git/**'] },
  bundleKey: 'artifact',
  anchor: {
    kind: 'reproducible-observation',
    description: '锚点是「可复现的观察」：给定输入与操作步骤，任何人事后都能复现出同一结果。不可复现的推断没有锚点。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '不删除，只标注「已验证/未验证」与验证方式。' },
  rules: [
    { name: 'reproducibility', match: ['**'], text: '可复现性：每条结论必须附输入、操作步骤与观察到的输出。无法复现的推断必须标记为猜想。' },
    { name: 'multiple-hypotheses', match: ['**'], text: '多假设保留：能解释当前证据的假设往往不止一个，必须并列给出并说明各自可被证伪的实验。' },
    { name: 'artifact-provenance', match: ['**'], text: '样本溯源性：分析对象的来源、版本、获取方式必须记录，否则结论无法被他人验证。' },
    { name: 'legal-scope', match: ['**'], text: '合法边界：分析目的、授权范围、以及是否触及受保护内容，必须显式记录。' },
  ],
  prompt: { role: '你是逆向分析者。你的损失取向是 recall-first：并列保留竞争假设，不急于收敛。', instruction: '每条结论给出可复现的观察步骤；未验证的明确标注。' },
}

export const projectManagement = {
  id: 'project-management',
  title: '项目管理',
  category: 'D',
  keywords: ['project', 'task', 'schedule', 'dependency', 'risk', 'milestone'],
  summary: '**关系型**：产物是一致性本身。锚点是「任务 ID + 依赖边」，跑在锚点链建出的图上。',
  lossOrientation: PRECISION,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'task-graph-edges',
    description: '任务节点与其依赖边。候选不是任务，是「一条边」或「一个节点在图中的位置」。',
  },
  gate: DOC_GATE,
  bundleKey: 'workstream',
  anchor: {
    kind: 'task-and-edge',
    description: '锚点是「任务 ID + 依赖边两端」。引擎在任务图上校验该边存在、方向正确、不构成环。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'fact-checker', description: '只删除任务图上不成立或重复的评论。' },
  rules: [
    { name: 'cycle-and-orphan', match: ['**'], text: '依赖完整性：任务图是否存在环；是否存在无来源也无去向的孤儿任务；关键路径是否被识别。' },
    { name: 'estimate-vs-scope', match: ['**'], text: '估算与范围匹配：任务描述所需的工作量与给出的估算是否量级一致；是否把未知项给了确定性估算。' },
    { name: 'single-owner', match: ['**'], text: '责任唯一：每个任务是否有且仅有一个负责人；跨团队接口是否有双方确认。' },
    { name: 'risk-register', match: ['**'], text: '风险登记：已识别的风险是否有触发条件、影响面与应对措施；「待观察」不算应对措施。' },
  ],
  prompt: { role: '你是项目管理评审者，评审的是计划图的一致性与完整性。', instruction: '每条发现给出任务 ID 与依赖边的两端。' },
}

export const userFeedback = {
  id: 'user-feedback',
  title: '用户对接反馈',
  category: 'D',
  keywords: ['feedback', 'support', 'ticket', 'voice-of-customer', 'churn'],
  summary: '把反馈与产品决策对上。锚点是「反馈 ID + 原话」。**默认 recall-first**：被静默丢弃的反馈是信任损耗。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'feedback-to-decision-links',
    description: '反馈条目与它们被采纳/拒绝/搁置的决策之间的边。未闭合的反馈是主要候选。',
  },
  gate: DOC_GATE,
  bundleKey: 'theme',
  anchor: {
    kind: 'feedback-and-quote',
    description: '锚点是「反馈 ID + 用户原话」。引擎校验该反馈存在且原话逐字匹配。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '只删除反馈库中不存在的条目；未闭合项一律保留。' },
  rules: [
    { name: 'closure', match: ['**'], text: '闭环性：每条反馈是否有终态（已采纳/已拒绝/已搁置/已回复）。无终态的必须列出。' },
    { name: 'rejection-reason', match: ['**'], text: '拒绝理由：被拒绝的反馈是否记录了对用户的说得过去的理由；「暂不支持」不是理由。' },
    { name: 'severity-vs-volume', match: ['**'], text: '严重度与频次分离：低频但高损的反馈不得被高频低损项淹没；两者必须分别排序。' },
    { name: 'verbatim-fidelity', match: ['**'], text: '原话保真：转述是否改变了用户的原意；情绪性表述是否被过度中性化而丢失了强度。' },
  ],
  prompt: { role: '你是用户声音分析师。你的损失取向是 recall-first：没有终态的反馈必须暴露。', instruction: '每条发现给出反馈 ID 与原话引用。' },
}

export const requirementAlignment = {
  id: 'requirement-alignment',
  title: '需求/潜在需求对齐',
  category: 'D',
  keywords: ['traceability', 'alignment', 'gap', 'coverage-of-requirements'],
  summary: '引擎的**元领域**：检查锚点链本身是否完整。锚点是「可追溯 ID 链」，它验证的是其他所有领域的产出。',
  lossOrientation: RECALL,
  status: 'ready',
  rulesStatus: 'starter',
  candidateSet: {
    kind: 'trace-edges',
    description: '锚点链上的每一条边：需求→方案→设计→实现→用例→反馈。断链与悬空引用是候选。',
  },
  gate: DOC_GATE,
  bundleKey: 'chain',
  anchor: {
    kind: 'id-chain',
    description: '锚点是「可追溯 ID 链」。引擎沿图双向校验：每个下游节点是否有上游来源，每个上游节点是否有下游承接。',
    verify: 'engine-recomputable',
  },
  criticism: { kind: 'triage', description: '只删除链上确实存在的边；断链一律保留。' },
  rules: [
    { name: 'forward-coverage', match: ['**'], text: '正向覆盖：每条需求是否都有下游承接。未被任何实现或用例承接的需求是断链。' },
    { name: 'backward-provenance', match: ['**'], text: '反向溯源：每项实现是否有上游需求来源。无来源的实现是范围蔓延或记录缺失。' },
    { name: 'latent-gap', match: ['**'], text: '潜在缺口：原话中存在但未被登记为需求的诉求。这是 recall-first 下最重要的发现类型。' },
    { name: 'stale-link', match: ['**'], text: '失效链接：指向已删除或已更名对象的 ID 引用。' },
  ],
  prompt: { role: '你是可追溯性审查者。你的损失取向是 recall-first：任何断链都必须暴露。', instruction: '每条发现给出来自链两端的 ID。' },
}

/** The complete built-in library, in the order packs are presented to the model. */
export const BUILTIN_DOMAINS = [
  // A — review
  codeReview,
  riskCompliance,
  uxReview,
  uiVisual,
  architecture,
  dataEngineering,
  algoModel,
  techTest,
  techDoc,
  operatorDesign,
  // B — construct
  requirementResearch,
  productPlanning,
  backendEngineering,
  frontendEngineering,
  // C — explore
  marketResearch,
  reverseEngineering,
  // D — relate
  projectManagement,
  userFeedback,
  requirementAlignment,
]

/** The nine domains where a miss is the expensive error. */
export const RECALL_FIRST_DOMAINS = BUILTIN_DOMAINS
  .filter((pack) => pack.lossOrientation === RECALL)
  .map((pack) => pack.id)

/**
 * Select packs by the `config.domains` value.
 * `'all'` / undefined -> every built-in; an array -> only the named ids.
 */
export function selectDomains(selection) {
  if (selection === undefined || selection === null || selection === 'all') return [...BUILTIN_DOMAINS]
  if (!Array.isArray(selection)) return [...BUILTIN_DOMAINS]
  const wanted = new Set(selection)
  return BUILTIN_DOMAINS.filter((pack) => wanted.has(pack.id))
}
