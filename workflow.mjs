export const roles = ['产品设计', '前端', '后端', '测试'];
export const testLevelLabels = {unit: '单元测试', integration: '集成测试', e2e: '端到端验收'};
const developmentRoles = new Set(['前端', '后端']);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function present(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

export function validate(plan) {
  check(present(plan?.project), '缺少项目名称');
  check(Array.isArray(plan.requirements) && plan.requirements.length > 0, '缺少需求');
  check(Array.isArray(plan.tasks) && plan.tasks.length >= 2 && plan.tasks.length <= 24, '任务数量应在 2 至 24 之间');
  const requirements = new Set();
  for (const req of plan.requirements) {
    check(/^R\d+$/.test(req.id) && !requirements.has(req.id) && present(req.text) && present(req.acceptance), '需求编号重复、无效或缺少验收标准');
    requirements.add(req.id);
  }
  const tasksById = new Map();
  const covered = new Set();
  const tested = new Set();
  for (const task of plan.tasks) {
    check(/^T\d+$/.test(task.id) && !tasksById.has(task.id), '任务编号重复或无效');
    check(present(task.title) && present(task.acceptance) && roles.includes(task.role), task.id + ' 缺少任务名称、角色或验收标准');
    check(Array.isArray(task.requirements) && task.requirements.length > 0 && task.requirements.every(id => requirements.has(id)), task.id + ' 引用了未知需求');
    for (const id of task.requirements) {
      if (task.role === '测试') tested.add(id);
      else covered.add(id);
    }
    check(Array.isArray(task.inputs) && task.inputs.every(present) && present(task.output), task.id + ' 的输入或交付物无效');
    tasksById.set(task.id, task);
  }
  for (const task of plan.tasks) {
    if (task.test === undefined) continue;
    const {level, targets} = task.test ?? {};
    check(task.role === '测试' && Object.hasOwn(testLevelLabels, level) && Array.isArray(targets) &&
      new Set(targets).size === targets.length && targets.length >= (level === 'integration' ? 2 : 1) &&
      (level !== 'unit' || targets.length === 1), task.id + ' 的测试层次或实现目标无效');
    check(targets.every(id => {
      const target = tasksById.get(id);
      return developmentRoles.has(target?.role) && task.inputs.includes(target.output);
    }), task.id + ' 必须依赖其测试目标的实现交付物');
  }
  check([...requirements].every(id => covered.has(id) && tested.has(id)), '每条需求都应有非测试任务和测试任务覆盖');
}

export function addTestTasks(plan) {
  const development = plan?.tasks;
  check(Array.isArray(development) && development.length >= 1 && development.length <= 8 &&
    development.every(task => task && task.role !== '测试' && task.test === undefined && Array.isArray(task.inputs)),
    '请拆出 1 至 8 项设计或实现任务，测试由编排器补齐');
  check(Array.isArray(plan.requirements) && plan.requirements.length > 0, '缺少需求');
  const implementations = development.filter(task => developmentRoles.has(task.role));
  check(implementations.length > 0, '至少需要一项可独立测试的前端或后端实现任务');
  const ids = new Set(development.map(task => task.id));
  const outputs = new Set(development.map(task => task.output));
  const producers = new Map(development.map(task => [task.output, task]));
  let nextId = 1;

  function makeTest(level, suffix, targets, inputs, acceptance) {
    while (ids.has('T' + nextId)) nextId++;
    const id = 'T' + nextId++;
    const designs = [...new Set(targets.flatMap(task => task.designs || []))];
    let output = 'test_result_' + id;
    while (outputs.has(output)) output += '_report';
    outputs.add(output);
    return {
      id, title: testLevelLabels[level] + ' · ' + suffix, role: '测试', output, inputs, acceptance,
      requirements: [...new Set(targets.flatMap(task => task.requirements))],
      ...(designs.length ? {designs} : {}),
      test: {level, targets: targets.filter(task => developmentRoles.has(task.role)).map(task => task.id)},
    };
  }

  const unit = new Map(implementations.map(task => [task.id, makeTest('unit', task.title, [task], [task.output],
    '隔离验证 ' + task.id + ' 的行为，检查正常输入、边界和异常：' + task.acceptance)]));
  const integration = new Map();
  for (const task of implementations) {
    const upstream = [...new Set(task.inputs.map(input => producers.get(input)))].filter(parent =>
      unit.has(parent?.id) && parent !== task);
    if (!upstream.length) continue;
    const targets = [...upstream, task];
    integration.set(task.id, makeTest('integration', task.title, targets,
      targets.flatMap(target => [target.output, unit.get(target.id).output]),
      '验证 ' + upstream.map(target => target.id).join('、') + ' → ' + task.id + ' 的接口、数据传递和异常处理'));
  }

  const tasks = development.flatMap(task => {
    const inputs = new Set(task.inputs);
    for (const input of task.inputs) {
      const parent = producers.get(input)?.id;
      if (unit.has(parent)) inputs.add(unit.get(parent).output);
      if (integration.has(parent)) inputs.add(integration.get(parent).output);
    }
    return [{...task, inputs: [...inputs]}, ...[unit.get(task.id), integration.get(task.id)].filter(Boolean)];
  });
  const end = makeTest('e2e', '全流程', development, tasks.map(task => task.output),
    '按需求规格验收端到端流程，核对核心场景与业务异常');
  end.requirements = plan.requirements.map(req => req.id);
  return {...plan, tasks: [...tasks, end]};
}

export function schedule(plan, capacity) {
  check(Number.isInteger(capacity) && capacity >= 1 && capacity <= 8, '并行上限须在 1 至 8 之间');
  validate(plan);
  const producers = new Map();
  for (const task of plan.tasks) {
    check(!producers.has(task.output), '交付物有多个生产任务：' + task.output);
    producers.set(task.output, task.id);
  }
  const dependencies = {};
  const edges = [];
  for (const task of plan.tasks) {
    dependencies[task.id] = [];
    const inputs = new Set(task.inputs);
    if (task.role === '测试' && !task.test) {
      for (const implementation of plan.tasks) {
        if (implementation.role !== '测试' &&
          implementation.requirements.some(id => task.requirements.includes(id))) {
          inputs.add(implementation.output);
        }
      }
    }
    for (const input of inputs) {
      const from = producers.get(input);
      check(from, task.id + ' 的输入缺少生产任务：' + input);
      check(from !== task.id, task.id + ' 依赖自己的交付物');
      dependencies[task.id].push(from);
      edges.push({from, to: task.id, artifact: input});
    }
  }
  const completed = new Set();
  const rounds = [];
  while (completed.size < plan.tasks.length) {
    const ready = plan.tasks.filter(task => !completed.has(task.id) &&
      dependencies[task.id].every(id => completed.has(id)));
    check(ready.length > 0, '检测到循环依赖，剩余任务：' +
      plan.tasks.filter(task => !completed.has(task.id)).map(task => task.id).join('、'));
    const batch = ready.slice(0, capacity).map(task => task.id);
    rounds.push(batch);
    for (const id of batch) completed.add(id);
  }
  return {capacity, rounds, dependencies, edges};
}
