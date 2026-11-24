import assert from 'node:assert/strict';
import test from 'node:test';
import {addTestTasks, schedule, serialImplementationChain} from '../workflow.mjs';
import {assignTestCases, bindTestCases, bindTestTasks, validateTaskLinks, validateTestPlan} from '../pipeline.mjs';
import {rollbackTask, taskState, transition, validateRuntime} from '../interaction.mjs';

const requirements = [
  {id:'R1', text:'展示并提交行程', acceptance:'拒绝无效的行程'},
  {id:'R2', text:'导出景点', acceptance:'表格包含全部景点'},
];
const design = {
  components: [{id:'D1', requirements:['R1']}, {id:'D2', requirements:['R2']}],
};
const plan = addTestTasks({project: '行程工作台', requirements, tasks: [
  {id:'T1', title:'实现行程校验', role:'后端', requirements:['R1'], designs:['D1'], inputs:[],
    output:'validator', acceptance:'拒绝负数时长'},
  {id:'T2', title:'实现编辑页', role:'前端', requirements:['R1'], designs:['D1'], inputs:['validator'],
    output:'editor', acceptance:'展示校验提示'},
  {id:'T3', title:'实现独立导出', role:'后端', requirements:['R2'], designs:['D2'], inputs:[],
    output:'csv', acceptance:'导出景点名称'},
  {id:'T4', title:'实现提交步骤', role:'前端', requirements:['R1'], designs:['D1'], inputs:['editor'],
    output:'submit', acceptance:'提交校验通过的行程'},
]});
const arrangement = schedule(plan, 4);
const unitFor = id => plan.tasks.find(task => task.test?.level === 'unit' && task.test.targets[0] === id);
const endToEnd = plan.tasks.find(task => task.test?.level === 'e2e');

test('unit tests gate handoffs and review runs in parallel', () => {
  const batchOf = id => arrangement.rounds.findIndex(batch => batch.includes(id));
  const unit = unitFor('T1');
  assert.deepEqual(arrangement.dependencies[unit.id], ['T1']);
  assert(arrangement.dependencies.T2.includes(unit.id));
  assert(batchOf(unit.id) < batchOf('T2'));
  assert(!arrangement.dependencies[unit.id].includes('T4'));
  const integration = plan.tasks.find(task => task.test?.level === 'integration' && task.test.targets.includes('T2'));
  assert.deepEqual(integration.test.targets, ['T1', 'T2']);
  assert(arrangement.dependencies[integration.id].includes(unitFor('T2').id));
  assert(arrangement.dependencies.T4.includes(unitFor('T2').id));
  assert(!arrangement.dependencies.T4.includes(integration.id));
  assert.equal(batchOf(integration.id), batchOf('T4'));
  for (const id of ['T1', 'T2', 'T3', 'T4']) {
    const review = plan.tasks.find(task => task.review?.target === id);
    assert.deepEqual(arrangement.dependencies[review.id], [id]);
    assert.equal(batchOf(review.id), batchOf(unitFor(id).id));
    assert(arrangement.dependencies[endToEnd.id].includes(review.id));
  }
  assert.deepEqual(arrangement.rounds.at(-1), [endToEnd.id]);
  validateTaskLinks(plan, design);
});

test('a shared contract enables coding branches and real joint integration', () => {
  const contract = {id:'T1', title:'约定行程接口', role:'后端', kind:'contract', requirements:['R1','R2'],
    designs:['D1','D2'], inputs:[], output:'contract', acceptance:'接口类型和错误码明确'};
  const modules = plan.tasks.filter(task => !task.test && !task.review && task.id !== 'T1')
    .map(task => ({...task, inputs:['contract']}));
  const branch = addTestTasks({project:plan.project, requirements, tasks:[contract, ...modules]});
  const {rounds} = schedule(branch, 4);
  assert.deepEqual(rounds[0], ['T1']);
  assert.deepEqual(rounds[1], ['T2','T3','T4']);
  assert.equal(branch.tasks.filter(task => task.review).length, 3);
  const joint = branch.tasks.find(task => task.test?.level === 'integration');
  assert.deepEqual(joint.test.targets, ['T2','T3','T4']);
  assert.deepEqual(serialImplementationChain(branch.tasks), []);
  assert.deepEqual(serialImplementationChain([
    contract, modules[0], {...modules[1], inputs:['editor']}, {...modules[2], inputs:['csv']},
  ]), ['T2','T3','T4']);
});

test('rollback resets only the implementation and downstream states, retaining notes', () => {
  const runtime = {};
  assert.throws(() => transition('T2', 'start', '提前开始', runtime, arrangement), /不支持/);
  for (const id of arrangement.rounds.flat()) {
    runtime[id] = transition(id, 'start', '执行', runtime, arrangement);
    runtime[id] = transition(id, id === endToEnd.id ? 'fail' : 'complete', '结果记录', runtime, arrangement);
  }
  assert.throws(() => rollbackTask(unitFor('T1'), 'T3', '错误目标', runtime, arrangement), /实际依赖/);
  assert.throws(() => rollbackTask(endToEnd, 'T1', ' ', runtime, arrangement), /定位依据/);
  const update = rollbackTask(endToEnd, 'T1', '负数输入未被拒绝', runtime, arrangement);
  assert.equal(runtime.T1.status, 'done');
  assert.equal(update.runtime.T1.status, 'failed');
  assert.equal(update.runtime.T2.status, 'pending');
  assert.equal(update.runtime.T4.status, 'pending');
  assert.equal(update.runtime[endToEnd.id].status, 'pending');
  assert.equal(update.runtime.T3, runtime.T3);
  assert.equal(update.runtime[unitFor('T3').id], runtime[unitFor('T3').id]);
  assert.equal(update.runtime.T2.notes.at(-1).test, endToEnd.id);
  assert.equal(taskState('T2', update.runtime, arrangement), 'pending');
  validateRuntime(JSON.parse(JSON.stringify(update.runtime)), plan, arrangement);
  update.runtime.T1 = transition('T1', 'retry', '补齐校验', update.runtime, arrangement);
  update.runtime.T1 = transition('T1', 'complete', '交付新实现', update.runtime, arrangement);
  assert.equal(taskState(unitFor('T1').id, update.runtime, arrangement), 'ready');
  assert.equal(taskState('T2', update.runtime, arrangement), 'pending');
  const unit = unitFor('T1').id;
  update.runtime[unit] = transition(unit, 'start', '重新执行', update.runtime, arrangement);
  update.runtime[unit] = transition(unit, 'complete', '单元测试报告', update.runtime, arrangement);
  assert.equal(taskState('T2', update.runtime, arrangement), 'ready');
});

test('test case associations are assigned by the workflow and remain valid', () => {
  const assignments = assignTestCases(design, plan);
  const cases = assignments.map(({id}) => ({id, title:'验证交付', setup:'准备测试数据', steps:['调用入口'],
    expected:'返回指定结果', design:'invalid', task:'invalid', requirements:['invalid']}));
  const result = bindTestCases({strategy:'逐层测试', cases}, assignments);
  validateTestPlan(result, design, plan);
  const withCases = bindTestTasks(plan, result);
  validateTestPlan(result, design, withCases);
  assert(withCases.tasks.filter(task => task.test).every(task => task.test.cases.length > 0));
  withCases.tasks.find(task => task.test).test.cases = ['TC999'];
  assert.throws(() => validateTestPlan(result, design, withCases), /不一致/);
  assert.throws(() => bindTestCases({strategy:'逐层测试', cases:cases.slice(1)}, assignments), /编号/);
});

test('a failed review returns to the reviewed code and preserves unrelated work', () => {
  const review = plan.tasks.find(task => task.review?.target === 'T1');
  const runtime = {};
  for (const id of arrangement.rounds.flat()) {
    runtime[id] = transition(id, 'start', '开始', runtime, arrangement);
    runtime[id] = transition(id, id === review.id ? 'fail' : 'complete', '记录', runtime, arrangement);
    if (id === review.id) break;
  }
  assert.throws(() => rollbackTask(review, 'T3', '错误目标', runtime, arrangement), /实际依赖/);
  const update = rollbackTask(review, 'T1', '缺少输入边界判断', runtime, arrangement);
  assert.equal(update.runtime.T1.status, 'failed');
  assert.equal(update.runtime[review.id].status, 'pending');
  assert.equal(update.runtime[unitFor('T1').id].status, 'pending');
  assert.equal(update.runtime.T3, runtime.T3);
  validateRuntime(update.runtime, plan, arrangement);
});

test('previous plans without test metadata retain their original dependencies', () => {
  const legacy = {project:'旧版', requirements:requirements.slice(0,1), tasks: [
    {id:'T1', title:'实现', role:'后端', requirements:['R1'], inputs:[], output:'api', acceptance:'交付'},
    {id:'T2', title:'测试', role:'测试', requirements:['R1'], inputs:[], output:'report', acceptance:'验收'},
  ]};
  assert.deepEqual(schedule(legacy, 4).rounds, [['T1'], ['T2']]);
});
