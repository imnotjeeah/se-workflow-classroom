export const roles = ['产品设计', '前端', '后端', '测试'];

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
  const ids = new Set();
  const covered = new Set();
  const tested = new Set();
  for (const task of plan.tasks) {
    check(/^T\d+$/.test(task.id) && !ids.has(task.id), '任务编号重复或无效');
    check(present(task.title) && present(task.acceptance) && roles.includes(task.role), task.id + ' 缺少任务名称、角色或验收标准');
    check(Array.isArray(task.requirements) && task.requirements.length > 0 && task.requirements.every(id => requirements.has(id)), task.id + ' 引用了未知需求');
    for (const id of task.requirements) {
      if (task.role === '测试') tested.add(id);
      else covered.add(id);
    }
    check(Array.isArray(task.inputs) && task.inputs.every(present) && present(task.output), task.id + ' 的输入或交付物无效');
    ids.add(task.id);
  }
  check([...requirements].every(id => covered.has(id) && tested.has(id)), '每条需求都应有非测试任务和测试任务覆盖');
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
    if (task.role === '测试') {
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
