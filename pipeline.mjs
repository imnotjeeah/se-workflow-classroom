function check(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, limit = 500) {
  return typeof value === 'string' && value.trim() && value.length <= limit;
}

function entries(list, prefix, label, limit = 12) {
  check(Array.isArray(list) && list.length > 0 && list.length <= limit, label + '需要 1 至 ' + limit + ' 个条目');
  const ids = new Set();
  for (const item of list) {
    check(typeof item?.id === 'string' && new RegExp('^' + prefix + '[1-9]\\d*$').test(item.id) &&
      !ids.has(item.id), label + '条目编号无效或重复');
    ids.add(item.id);
  }
  return ids;
}

function references(ids, available) {
  return Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length &&
    ids.every(id => available.has(id));
}

export function validateRequirements(document) {
  check(text(document?.project, 120) && text(document.goal) && text(document.scope), '需求规格缺少项目名称、目标或范围');
  entries(document.requirements, 'R', '需求规格');
  for (const req of document.requirements) {
    check(text(req.text) && text(req.acceptance), req.id + ' 缺少需求描述或可验证的验收条件');
  }
}

export function validateDesign(design, requirements) {
  validateRequirements(requirements);
  check(text(design?.summary, 1000), '设计规格缺少总体设计');
  entries(design.components, 'D', '设计规格');
  const known = new Set(requirements.requirements.map(req => req.id));
  const covered = new Set();
  for (const part of design.components) {
    check(text(part.title, 120) && text(part.design, 800) && text(part.contract, 600),
      part.id + ' 缺少模块名称、实现设计或接口与数据约定');
    check(references(part.requirements, known), part.id + ' 引用了不存在或重复的需求编号');
    for (const id of part.requirements) covered.add(id);
  }
  check(covered.size === known.size, '存在尚未关联设计模块的需求');
}

export function validateTaskLinks(plan, design) {
  const components = new Map(design.components.map(part => [part.id, part]));
  const development = new Set();
  const tests = new Set();
  for (const task of plan.tasks) {
    check(references(task.designs, components), task.id + ' 需要关联有效的设计编号');
    const implied = new Set(task.designs.flatMap(id => components.get(id).requirements));
    check(task.requirements.every(id => implied.has(id)), task.id + ' 的需求编号超出关联设计覆盖的范围');
    check(task.designs.every(id => components.get(id).requirements.some(req => task.requirements.includes(req))),
      task.id + ' 的关联设计和需求需要有交集');
    const target = task.role === '测试' ? tests : development;
    for (const id of task.designs) target.add(id);
  }
  check(development.size === components.size && tests.size === components.size,
    '每项设计都需要开发任务和验收测试');
}

export function assignTestCases(design, plan) {
  const testers = plan.tasks.filter(task => task.role === '测试');
  const candidates = testers.flatMap(task => design.components
    .filter(part => task.designs.includes(part.id))
    .map(part => ({
      task: task.id, design: part.id,
      requirements: part.requirements.filter(id => task.requirements.includes(id)),
    }))
    .sort((a, b) => b.requirements.length - a.requirements.length));
  const selected = testers.map(task => candidates.find(candidate => candidate.task === task.id));
  const coveredRequirements = new Set(selected.flatMap(item => item.requirements));
  const coveredDesigns = new Set(selected.map(item => item.design));
  for (const item of candidates) {
    if (coveredDesigns.has(item.design) && item.requirements.every(id => coveredRequirements.has(id))) continue;
    selected.push(item);
    coveredDesigns.add(item.design);
    item.requirements.forEach(id => coveredRequirements.add(id));
  }
  return selected.map((item, index) => ({id: 'TC' + (index + 1), ...item}));
}

export function bindTestCases(value, assignments) {
  entries(value?.cases, 'TC', '测试方案', 48);
  const given = new Map(value.cases.map(item => [item.id, item]));
  check(given.size === assignments.length && assignments.every(item => given.has(item.id)),
    '测试用例编号必须与分配清单完全一致');
  return {strategy: value.strategy, cases: assignments.map(item => ({...given.get(item.id), ...item}))};
}

export function validateTestPlan(value, design, plan) {
  check(text(value?.strategy, 1000), '测试方案缺少范围与方法');
  entries(value.cases, 'TC', '测试方案', 48);
  const designById = new Map(design.components.map(part => [part.id, part]));
  const testers = new Map(plan.tasks.filter(task => task.role === '测试').map(task => [task.id, task]));
  const coveredRequirements = new Set();
  const coveredDesigns = new Set();
  const coveredTasks = new Set();
  for (const test of value.cases) {
    const part = designById.get(test.design);
    const task = testers.get(test.task);
    check(part && task?.designs.includes(part.id), test.id + ' 的设计编号与测试任务不匹配');
    check(references(test.requirements, new Set(part.requirements.filter(id => task.requirements.includes(id)))),
      test.id + ' 引用了与设计或测试任务无关的需求');
    check(text(test.title, 120) && text(test.setup) && text(test.expected) && Array.isArray(test.steps) &&
      test.steps.length > 0 && test.steps.length <= 10 && test.steps.every(step => text(step, 300)),
      test.id + ' 缺少标题、前置条件、可执行步骤或预期结果');
    test.requirements.forEach(id => coveredRequirements.add(id));
    coveredDesigns.add(part.id);
    coveredTasks.add(task.id);
  }
  check(plan.requirements.every(req => coveredRequirements.has(req.id)), '存在未被用例覆盖的需求');
  check(coveredDesigns.size === designById.size && coveredTasks.size === testers.size,
    '每项设计及测试任务都需要关联测试用例');
}

export function designMarkdown(requirements, design) {
  const lines = ['# ' + requirements.project + ' · 设计规格', '', '## 总体设计', '', design.summary, '',
    '## 模块设计', ''];
  for (const part of design.components) {
    lines.push('### ' + part.id + ' · ' + part.title, '', '关联需求：' + part.requirements.join('、'), '',
      part.design, '', '接口与数据约定：' + part.contract, '');
  }
  return lines.join('\n');
}

export function designFeedback(design, plan, arrangement) {
  const batchOf = new Map(arrangement.rounds.flatMap((ids, index) => ids.map(id => [id, index + 1])));
  return design.components.map(part => ({
    ...part,
    tasks: plan.tasks.filter(task => task.designs.includes(part.id)).map(task => ({
      id: task.id, title: task.title, role: task.role, batch: batchOf.get(task.id),
      output: task.output, acceptance: task.acceptance, predecessors: arrangement.dependencies[task.id],
    })),
  }));
}
