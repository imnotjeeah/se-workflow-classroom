import { examples } from './examples.mjs';
import { schedule } from './workflow.mjs';
import { validateDesign, validateTaskLinks, validateTestPlan, designMarkdown, designFeedback } from './pipeline.mjs';
import { createObservability } from './observability.mjs';

const byId = id => document.getElementById(id);
const directFile = location.protocol === 'file:';
const apiBase = directFile ? 'http://127.0.0.1:8765' : '';
const spec = byId('spec');
const inputMode = byId('input-mode');
const example = byId('example');
const capacity = byId('capacity');
const file = byId('file');
const run = byId('run');
const replay = byId('replay');
const notice = byId('notice');
const view = byId('view');
const keyDialog = byId('key-dialog');
const keyInput = byId('key-input');
const tabs = [...document.querySelectorAll('[data-view]')];
let result, arrangement, observer;
let pageKey, apiStatus;
let active = 'tasks';
let selected = '';
let requirementFilter = '';
let busy = false;
let pipeline;
let chainView = 'idea';
let runningStage = '';
const steps = [
  ['idea', '产品想法'], ['requirements', '需求规格'], ['design', '设计规格'],
  ['schedule', '任务编排'], ['feedback', '设计回填'], ['tests', '测试方案'],
];
const stepLabels = new Map(steps);
const monitor = createObservability({
  request: requestStage, ready: ensureReady, getResult: () => result, getArrangement: () => arrangement,
  download: downloadFile, isBusy: () => busy, setBusy: lock,
  adopt: text => {
    inputMode.value = 'idea';
    spec.value = text;
    changeSpec(true);
  },
});

function element(tag, content = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = content;
  node.className = className;
  return node;
}

example.add(new Option('自定义输入', ''));
examples.forEach(({name}, index) => example.add(new Option(name, String(index))));
for (let n = 1; n <= 8; n++) capacity.add(new Option(String(n), String(n)));
capacity.value = '4';

function modeLabel() {
  return inputMode.value === 'idea' ? '产品想法' : '设计规格';
}

function runLabel() {
  if (inputMode.value === 'design') return '运行任务编排 ↗';
  if (pipeline?.requirements && !pipeline.testPlan) return '继续完整流程 ↗';
  return '运行完整流程 ↗';
}

function updateInput() {
  byId('count').textContent = spec.value.length + ' / 4000';
  byId('spec-label').textContent = modeLabel();
  const field = inputMode.value === 'idea' ? 'idea' : 'spec';
  const match = examples.findIndex(item => item[field] === spec.value);
  example.value = match < 0 ? '' : String(match);
  byId('input-error').textContent = '';
}

function statusMessage(title, body) {
  notice.hidden = false;
  byId('results').hidden = true;
  byId('exports').hidden = true;
  byId('result-title').textContent = '工作流输出';
  byId('provenance').textContent = '';
  byId('notice-title').textContent = title;
  byId('notice-body').textContent = body;
  observer?.disconnect();
}

function changeSpec(preserveDiscussion = false) {
  result = undefined;
  pipeline = undefined;
  chainView = 'idea';
  if (preserveDiscussion !== true) monitor.reset();
  updateInput();
  run.textContent = runLabel();
  statusMessage('等待运行工作流', inputMode.value === 'idea'
    ? '输入想法或选择案例，依次生成需求规格、设计规格、任务编排、设计回填和测试方案。'
    : '输入已有设计规格，查看任务分解和依赖关系。');
  renderChain();
}
spec.value = examples[0].idea;
spec.addEventListener('input', changeSpec);
example.addEventListener('change', () => {
  const field = inputMode.value === 'idea' ? 'idea' : 'spec';
  spec.value = examples[example.value]?.[field] ?? '';
  changeSpec();
  if (!example.value) spec.focus();
});
inputMode.addEventListener('change', () => {
  const item = examples[example.value];
  if (item) spec.value = inputMode.value === 'idea' ? item.idea : item.spec;
  changeSpec();
});
file.addEventListener('change', async () => {
  const chosen = file.files[0];
  file.value = '';
  if (!chosen) return;
  try {
    const content = await chosen.text();
    if (content.length > 4000) throw new Error('文件正文最多 4000 字。');
    if (content.includes('\uFFFD')) throw new Error('请将文件另存为 UTF-8 后重新导入。');
    if (busy) return;
    spec.value = content;
    changeSpec();
  } catch (error) {
    byId('input-error').textContent = error.message;
  }
});

function renderConnection() {
  const connection = byId('connection');
  if (!apiStatus) {
    connection.textContent = '生成服务未连接';
    connection.classList.remove('ready');
    return;
  }
  const configured = Boolean(pageKey) || (!directFile && apiStatus.configured);
  connection.textContent = configured ? '密钥已填写 · ' + apiStatus.model : '尚未填写密钥';
  connection.classList.toggle('ready', configured);
}
async function checkStatus() {
  try {
    const response = await fetch(apiBase + '/api/status', {signal: AbortSignal.timeout(2500)});
    if (!response.ok) throw new Error('status unavailable');
    apiStatus = await response.json();
  } catch {
    apiStatus = undefined;
  }
  byId('service-help').hidden = Boolean(apiStatus);
  renderConnection();
}

function openKeyDialog() {
  keyInput.value = '';
  byId('key-error').textContent = '';
  if (!keyDialog.open) keyDialog.showModal();
}

byId('configure').addEventListener('click', openKeyDialog);
byId('cancel-key').addEventListener('click', () => keyDialog.close());
keyDialog.addEventListener('close', () => { keyInput.value = ''; });
byId('key-form').addEventListener('submit', event => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) {
    byId('key-error').textContent = '请检查是否复制了多余字符。';
    keyInput.focus();
    return;
  }
  pageKey = key;
  keyDialog.close();
  renderConnection();
});

function lock(value) {
  busy = value;
  for (const control of [spec, inputMode, example, capacity, file, replay, run]) control.disabled = value;
  notice.classList.toggle('busy', value);
  run.textContent = value ? '正在生成…' : runLabel();
}

async function requestStage(endpoint, body) {
  const labels = {discussion:'讨论提炼',requirements:'想法 → 需求规格',design:'需求 → 设计规格',
    decompose:'设计 → WBS → 编排', 'test-plan':'设计与任务 → 测试方案'};
  const label = labels[endpoint] || endpoint;
  const started = performance.now();
  monitor.log(label, '开始', '已提交 DeepSeek API 请求');
  try {
    const response = await fetch(apiBase + '/api/' + endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...body, apiKey: pageKey}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    monitor.log(label, '完成', '产物通过结构校验，耗时 ' + ((performance.now()-started)/1000).toFixed(1) + ' 秒',
      {model:data.model, validations: data.validations || []});
    for (const message of data.validations || []) monitor.log(label, '校验修正', message);
    return data;
  } catch (error) {
    monitor.log(label, '失败', error.message);
    throw error;
  }
}

async function runPipeline(idea) {
  pipeline ??= {idea};
  if (!pipeline.requirements) {
    runningStage = 'requirements';
    renderChain();
    statusMessage('正在生成需求规格', '作业一 · 将产品想法整理为编号需求和验收条件。');
    const data = await requestStage('requirements', {idea});
    pipeline.requirements = data.requirements;
    chainView = 'requirements';
  }
  if (!pipeline.design) {
    runningStage = 'design';
    renderChain();
    statusMessage('正在生成设计规格', '根据需求规格生成总体设计、模块划分和接口约定。');
    const data = await requestStage('design', {requirements: pipeline.requirements});
    pipeline.design = data.design;
    chainView = 'design';
  }
  const {requirements, design} = pipeline;
  if (!result) {
    runningStage = 'schedule';
    renderChain();
    statusMessage('正在分解并编排任务', '作业二 · 按设计条目分解任务，计算依赖和批次，然后回填到设计规格。');
    const data = await requestStage('decompose', {requirements, design});
    show({...data, spec: designMarkdown(requirements, design), pipeline});
    monitor.log('任务编排', '完成', result.plan.tasks.length + ' 项任务，' + arrangement.rounds.length + ' 个执行批次');
    chainView = 'feedback';
  }
  runningStage = 'tests';
  renderChain();
  const data = await requestStage('test-plan', {requirements, design, plan: result.plan});
  pipeline.testPlan = data.testPlan;
  chainView = 'tests';
}

async function ensureReady() {
  if (!apiStatus) await checkStatus();
  if (busy) return false;
  if (!apiStatus) {
    byId('input-error').textContent = '生成服务未连接。启动后再点一次「运行工作流」。';
    return false;
  }
  if (!pageKey && (directFile || !apiStatus.configured)) {
    openKeyDialog();
    return false;
  }
  return true;
}

run.addEventListener('click', async () => {
  if (busy) return;
  if (spec.value.trim().length < 15) {
    byId('input-error').textContent = '请输入至少 15 字的' + modeLabel() + '。';
    spec.focus();
    return;
  }
  if (!await ensureReady()) return;
  if (result && (inputMode.value === 'design' || pipeline?.testPlan)) {
    pipeline = undefined;
    chainView = 'idea';
    result = undefined;
    monitor.resetRuntime();
  }
  byId('input-error').textContent = '';
  lock(true);
  try {
    if (inputMode.value === 'idea') {
      await runPipeline(spec.value);
    } else {
      statusMessage('PM Agent 正在分解任务', 'DeepSeek 正在根据设计规格生成开发任务，编排器随后计算批次。');
      const data = await requestStage('decompose', {spec: spec.value});
      show({...data, spec: spec.value});
    }
  } catch (error) {
    const title = runningStage ? stepLabels.get(runningStage) + '生成失败' : '生成失败';
    if (result) byId('input-error').textContent = title + '。' + error.message;
    else statusMessage(title, error.message);
    if (error instanceof TypeError) await checkStatus();
  } finally {
    runningStage = '';
    lock(false);
    renderChain();
  }
});

replay.addEventListener('change', async () => {
  const chosen = replay.files[0];
  replay.value = '';
  if (!chosen) return;
  try {
    if (chosen.size > 1024 * 1024) throw new Error('结果文件最多 1 MB。');
    const {provider, spec: source, plan, model, generatedAt, pipeline: chain, observation} = JSON.parse(await chosen.text());
    if (busy) return;
    const input = chain === undefined ? source : chain?.idea;
    if (provider !== 'deepseek' || typeof input !== 'string' || input.trim().length < 15 ||
        input.length > 4000 || typeof model !== 'string' || !model.trim()) {
      throw new Error('请选择此工作台导出的 DeepSeek 结果 JSON。');
    }
    let sourceDesign = source;
    let restoredPlan = plan;
    if (chain) {
      validateDesign(chain.design, chain.requirements);
      sourceDesign = designMarkdown(chain.requirements, chain.design);
      restoredPlan = {...plan, project: chain.requirements.project, requirements: chain.requirements.requirements};
      schedule(restoredPlan, Number(capacity.value));
      validateTaskLinks(restoredPlan, chain.design);
      if (chain.testPlan !== undefined) validateTestPlan(chain.testPlan, chain.design, restoredPlan);
    } else {
      schedule(restoredPlan, Number(capacity.value));
    }
    const restoredArrangement = schedule(restoredPlan, Number(capacity.value));
    monitor.restore(observation, restoredPlan, restoredArrangement);
    pipeline = chain;
    inputMode.value = chain ? 'idea' : 'design';
    chainView = chain ? 'design' : 'idea';
    show({provider, spec: sourceDesign, plan: restoredPlan, model, generatedAt, pipeline, mode: 'imported'});
    spec.value = input;
    updateInput();
    run.textContent = runLabel();
    renderChain();
  } catch (error) {
    byId('input-error').textContent = error instanceof SyntaxError ? '结果文件不是有效的 JSON。' : error.message;
  }
});

function show(data) {
  arrangement = schedule(data.plan, Number(capacity.value));
  result = data;
  selected = '';
  requirementFilter = '';
  byId('result-title').textContent = result.plan.project;
  byId('provenance').textContent =
    (data.mode === 'live' ? '现场生成 · DeepSeek API' : '已导入 DeepSeek 结果') + ' · ' + data.model;
  notice.hidden = true;
  byId('results').hidden = false;
  byId('exports').hidden = false;
  render();
}

capacity.addEventListener('change', () => {
  if (!result) return;
  arrangement = schedule(result.plan, Number(capacity.value));
  monitor.log('重新编排', '完成', '每批并行上限 ' + capacity.value + '，共 ' + arrangement.rounds.length + ' 批');
  render();
  renderChain();
});
tabs.forEach(button => button.addEventListener('click', () => {
  active = button.dataset.view;
  render();
}));

byId('go-spec').addEventListener('click', () => {
  if (pipeline?.design) {
    openChain('design');
    return;
  }
  byId('input-title').scrollIntoView({block: 'start'});
  if (!busy) spec.focus({preventScroll: true});
});

function openResults(viewName) {
  active = viewName;
  if (result) render();
  else if (!busy) {
    const showTasks = viewName === 'tasks';
    statusMessage(showTasks ? 'PM Agent · 等待分解任务' : '任务编排 · 等待生成依赖图',
      showTasks ? '点击「运行工作流」，查看 DeepSeek 从设计规格拆出的任务。'
        : '点击「运行工作流」，或导入已有结果，查看任务依赖和执行批次。');
  }
  const title = byId('result-title');
  title.scrollIntoView({block: 'start'});
  title.focus({preventScroll: true});
}

byId('go-tasks').addEventListener('click', () => openResults('tasks'));
byId('go-graph').addEventListener('click', () => openResults('graph'));

function openChain(step) {
  chainView = step;
  renderChain();
  if (step === 'schedule') {
    openResults('graph');
    return;
  }
  byId('chain-content').focus();
}

function designCard(part) {
  const card = element('article', '', 'chain-card');
  card.append(element('h4', part.id + ' · ' + part.title),
    element('p', '关联需求：' + part.requirements.join('、'), 'hint'),
    element('p', part.design),
    element('p', '接口与数据约定：' + part.contract));
  return card;
}

function renderChain() {
  const chain = byId('chain');
  chain.hidden = inputMode.value !== 'idea';
  if (chain.hidden) return;
  const available = {
    idea: Boolean(spec.value.trim()), requirements: Boolean(pipeline?.requirements),
    design: Boolean(pipeline?.design), schedule: Boolean(result), feedback: Boolean(result),
    tests: Boolean(pipeline?.testPlan),
  };
  byId('chain-steps').replaceChildren(...steps.map(([id, label]) => {
    const step = element('button', label);
    step.type = 'button';
    step.disabled = !available[id];
    step.setAttribute('aria-pressed', String(id === chainView));
    step.append(element('span', id === runningStage ? '生成中' : available[id]
      ? (id === 'idea' ? '原始输入' : '可查看') : '待生成'));
    step.addEventListener('click', () => openChain(id));
    return step;
  }));
  const content = byId('chain-content');
  content.replaceChildren();
  if (chainView === 'schedule') {
    content.append(element('p', '设计规格 → 开发任务 → 依赖图和执行批次。请在下方切换查看。', 'hint'));
    return;
  }
  if (chainView === 'idea') {
    content.append(element('h3', '原始产品想法'), element('p', spec.value || '请在左侧填写产品想法。', 'chain-text'));
    return;
  }
  const {requirements, design} = pipeline;
  if (chainView === 'requirements') {
    content.append(element('h3', '作业一 · 需求规格'),
      element('p', '目标：' + requirements.goal), element('p', '项目范围：' + requirements.scope));
    for (const req of requirements.requirements) {
      const card = element('article', '', 'chain-card');
      card.append(element('h4', req.id + ' · ' + req.text), element('p', '验收：' + req.acceptance));
      content.append(card);
    }
    return;
  }
  if (chainView === 'design') {
    content.append(element('h3', '设计规格 · 总体设计与模块'), element('p', design.summary));
    content.append(...design.components.map(designCard));
    return;
  }
  if (chainView === 'tests') {
    const {strategy, cases} = pipeline.testPlan;
    content.append(element('h3', '测试方案'), element('p', strategy));
    for (const test of cases) {
      const card = element('article', '', 'chain-card');
      const link = element('button', '查看测试任务 ' + test.task, 'task-link');
      link.type = 'button';
      link.addEventListener('click', () => locateGraphTask(test.task));
      const list = element('ol', '', 'test-steps');
      test.steps.forEach(step => list.append(element('li', step)));
      const batch = arrangement.rounds.findIndex(ids => ids.includes(test.task)) + 1;
      card.append(element('h4', test.id + ' · ' + test.title),
        element('p', test.requirements.join('、') + ' → ' + test.design + ' → ' + test.task + ' · 第 ' + batch + ' 批',
          'hint'),
        element('p', '前置条件：' + test.setup), list,
        element('p', '预期结果：' + test.expected), link);
      content.append(card);
    }
    return;
  }
  content.append(element('h3', '设计规格回填版'), element('p', design.summary),
    element('p', '每项设计下列出编排结果、前置任务和验收依据。调整并行上限后同步更新批次。', 'hint'));
  for (const part of designFeedback(design, result.plan, arrangement)) {
    const card = designCard(part);
    for (const task of part.tasks) {
      const row = element('div', '', 'feedback-task');
      const link = element('button', task.id + ' · ' + task.title, 'task-link');
      link.type = 'button';
      link.addEventListener('click', () => locateGraphTask(task.id));
      row.append(link, element('p', '第 ' + task.batch + ' 批 · ' + task.role + ' · 交付物 ' + task.output),
        element('p', '前置任务：' + (task.predecessors.join('、') || '无') + '。验收：' + task.acceptance));
      card.append(row);
    }
    content.append(card);
  }
}

function locateGraphTask(id) {
  selected = id;
  openResults('graph');
  const node = byId('node-' + id);
  node.scrollIntoView({block: 'nearest', inline: 'center'});
  node.focus({preventScroll: true});
}

function metrics() {
  const items = [
    [result.plan.requirements.length, '条需求'],
    [result.plan.tasks.length, '项任务'],
    [arrangement.edges.length, '条依赖'],
    [arrangement.rounds.length, '个批次'],
  ];
  byId('metrics').replaceChildren(...items.map(([value, label]) => {
    const card = element('div', '', 'metric');
    card.append(element('strong', value), label);
    return card;
  }));
}

function taskCard(task, full = false, interactive = false) {
  const card = element(interactive ? 'button' : 'article', '', 'task');
  
  if (interactive) {
    if (task.role === '前端') card.style.borderLeft = '4px solid #3498db';
    if (task.role === '后端') card.style.borderLeft = '4px solid #e74c3c';
    if (task.role === '测试') card.style.borderLeft = '4px solid #f39c12';
    if (task.role === '产品设计') card.style.borderLeft = '4px solid #9b59b6';
  }

  card.append(element('span', task.id + ' · ' + task.role + ' · ' + task.requirements.join('、'), 'task-meta'),
    element('strong', task.title));
    
  if (full) {
    card.append(
      element('p', '声明输入：' + (task.inputs.join('、') || 'Design Spec')),
      element('p', '交付：' + task.output),
      element('p', '验收：' + task.acceptance));
    if (result.pipeline) card.append(element('p', '设计来源：' + task.designs.join('、')));
    const added = arrangement.edges.filter(edge => edge.to === task.id && !task.inputs.includes(edge.artifact));
    if (added.length) card.append(element('p', '编排补齐的输入：' + added.map(edge => edge.artifact).join('、')));
  }
  return card;
}

byId('gen-code').addEventListener('click', () => {
  const projectName = result ? result.plan.project : '当前项目';
  
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(244, 247, 244, 0.85); backdrop-filter: blur(4px); z-index:99999; display:flex; justify-content:center; align-items:center;';
  
  const box = document.createElement('div');
  box.style.cssText = 'background:#ffffff; width:80%; max-width:850px; border-radius:12px; border:1px solid #d6e2da; box-shadow: 0 10px 40px rgba(11, 101, 76, 0.15); overflow:hidden; text-align:left; display:flex; flex-direction:column;';
  
  const codeStr = `
// 任务：${projectName} - 核心后端接口与数据模型
// 框架：Node.js + TypeScript + Express

import { Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { verifyToken } from '../middlewares/auth';

export const executeCoreTask = async (req: Request, res: Response) => {
  try {
    const { days, spots } = req.body;
    
    if (!Number.isInteger(days) || days <= 0) {
      return res.status(400).json({ error: '参数校验失败，天数必须为正整数' });
    }

    const record = await prisma.coreTask.create({
      data: {
        userId: req.user.id,
        days: days,
        status: 'PENDING'
      }
    });

    return res.status(201).json({ success: true, data: record });
  } catch (error) {
    console.error('[Server Error]', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};`;

  box.innerHTML = '<div style="background:#f8faf9; padding:12px 20px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #d6e2da;">'
                + '<div style="display:flex; align-items:center; gap:10px;">'
                + '<span style="color:#0b654c; font-weight:bold; font-size:14px;">后端代码示例</span>'
                + '<span style="background:#e9f3ed; color:#0b654c; font-size:12px; padding:2px 8px; border-radius:12px; border:1px solid #c2dfd3;">内置展示片段 · 待适配与验证</span>'
                + '</div>'
                + '<button id="close-code-btn" style="background:#0b654c; color:white; border:none; padding:6px 16px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:13px; transition:0.2s;" onmouseover="this.style.background=\'#094b39\'" onmouseout="this.style.background=\'#0b654c\'">关闭</button>'
                + '</div>'
                + '<div style="background:#ffffff; padding:20px; overflow:auto; max-height:60vh;">'
                + '<pre style="margin:0; font-family:Consolas, monospace; font-size:14px; line-height:1.6;"><code id="code-content"></code></pre>'
                + '</div>';
  
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const codeEl = document.getElementById('code-content');
  let i = 0;
  
  function typeCode() {
    if (i < codeStr.length) {
      const chunk = codeStr.slice(i, i + 5);
      codeEl.textContent += chunk;
      
      i += 5;
      codeEl.parentElement.scrollTop = codeEl.parentElement.scrollHeight;
      setTimeout(typeCode, 10); 
    }
  }
  
  typeCode();

  document.getElementById('close-code-btn').addEventListener('click', () => {
    overlay.remove();
  });
});

function listTasks() {
  const table = element('details');
  table.open = true;
  table.append(element('summary', '需求与验收 · ' + result.plan.requirements.length + ' 条已关联任务与测试'));
  table.append(element('p', '点击需求编号，查看支撑该需求的任务和验收。', 'hint trace-hint'));
  const list = element('ul', '', 'requirements');
  const taskList = element('div', '', 'task-list');
  const matchStatus = element('div', '', 'hint');
  matchStatus.setAttribute('role', 'status');
  const clear = element('button', '显示全部任务');
  clear.type = 'button';
  const traceButtons = new Map();

  function filter(id) {
    requirementFilter = id;
    for (const [reqId, button] of traceButtons) button.setAttribute('aria-pressed', String(id === reqId));
    const matches = result.plan.tasks.filter(task => !id || task.requirements.includes(id));
    matchStatus.textContent = (id ? id + ' 对应' : '全部') + ' ' + matches.length + ' 项任务';
    clear.hidden = !id;
    taskList.replaceChildren(...matches.map(task => {
      const card = taskCard(task, true);
      const locate = element('button', '在依赖图中查看', 'task-link');
      locate.type = 'button';
      locate.addEventListener('click', () => locateGraphTask(task.id));
      card.append(locate);
      return card;
    }));
  }

  clear.addEventListener('click', () => {
    const previous = traceButtons.get(requirementFilter);
    filter('');
    previous?.focus();
  });
  for (const requirement of result.plan.requirements) {
    const item = element('li', '', 'trace-row');
    const trace = element('button', requirement.id, 'trace-button');
    trace.type = 'button';
    trace.setAttribute('aria-label', '查看 ' + requirement.id + ' 的关联任务');
    trace.addEventListener('click', () => filter(requirementFilter === requirement.id ? '' : requirement.id));
    traceButtons.set(requirement.id, trace);
    const description = element('div');
    description.append(element('strong', requirement.text), element('br'), element('span', '验收：' + requirement.acceptance));
    item.append(trace, description);
    list.append(item);
  }
  table.append(list);
  const toolbar = element('div', '', 'trace-toolbar');
  toolbar.append(matchStatus, clear);
  view.append(table, toolbar, taskList);
  filter(requirementFilter);
}

function showRounds(tasksById) {
  view.append(element('p', '当前每批最多 ' + arrangement.capacity + ' 项。上一批全部完成后，下一批才开始。同批任务可并行。', 'hint'));
  arrangement.rounds.forEach((ids, index) => {
    const round = element('section', '', 'round');
    const tasks = element('div', '', 'task-list');
    const cards = ids.map(id => {
      const card = taskCard(tasksById.get(id));
      card.append(element('p', '前置任务：' + (arrangement.dependencies[id].join('、') || '无')));
      return card;
    });
    tasks.append(...cards);
    round.append(element('h3', '第 ' + (index + 1) + ' 批 · ' + ids.length + ' 项'), tasks);
    view.append(round);
  });
}

function overviewEdges(edges, ids) {
  const successors = new Map(ids.map(id => [id, []]));
  for (const {from, to} of edges) successors.get(from).push(to);
  return edges.filter(({from, to}) => {
    const pending = successors.get(from).filter(id => id !== to);
    const seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === to) return false;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...successors.get(id));
    }
    return true;
  });
}

function spreadPorts(routes, endpoint, other, coordinate) {
  const groups = new Map();
  for (const route of routes) {
    const node = route[endpoint];
    if (!groups.has(node)) groups.set(node, []);
    groups.get(node).push(route);
  }
  for (const [node, group] of groups) {
    group.sort((a, b) => a[other].middle - b[other].middle || a[other].batch - b[other].batch);
    const spacing = Math.min(12, (node.height - 18) / group.length);
    group.forEach((route, index) => {
      route[coordinate] = node.middle + (index - (group.length - 1) / 2) * spacing;
    });
  }
}

function showGraph(tasksById) {
  const toolbar = element('div', '', 'graph-toolbar');
  const explanation = element('p', '', 'hint');
  explanation.setAttribute('role', 'status');
  const reset = element('button', '返回总览');
  reset.type = 'button';
  toolbar.append(explanation, reset);
  view.append(toolbar);
  const scroll = element('div', '', 'graph-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', '可横向滚动的任务依赖图');
  const graph = element('div', '', 'graph');
  const canvas = element('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  graph.append(canvas);
  scroll.append(graph);
  const detail = element('div', '', 'graph-detail');
  const buttons = new Map();
  const columns = [];
  const batches = new Map(arrangement.rounds.flatMap((ids, batch) => ids.map(id => [id, batch])));
  const overview = overviewEdges(arrangement.edges, [...batches.keys()]);

  function draw() {
    const edges = selected
      ? arrangement.edges.filter(edge => edge.from === selected || edge.to === selected)
      : overview;
    const bounds = graph.getBoundingClientRect();
    const nodes = new Map([...buttons].map(([id, button]) => {
      const box = button.getBoundingClientRect();
      return [id, {
        left: box.left - bounds.left, right: box.right - bounds.left,
        middle: box.top + box.height / 2 - bounds.top, height: box.height, batch: batches.get(id),
      }];
    }));
    const routes = edges.map(edge => ({edge, start: nodes.get(edge.from), end: nodes.get(edge.to)}));
    spreadPorts(routes, 'start', 'end', 'y1');
    spreadPorts(routes, 'end', 'start', 'y2');

    const gutters = columns.slice(1).map(() => []);
    const longRoutes = [];
    for (const route of routes) {
      const {start, end} = route;
      if (end.batch === start.batch + 1) {
        gutters[start.batch].push({route, key: 'out', order: route.y1 - route.y2});
      } else {
        gutters[start.batch].push({route, key: 'out', order: -Infinity});
        gutters[end.batch - 1].push({route, key: 'in', order: Infinity});
        longRoutes.push(route);
      }
    }
    gutters.forEach((tracks, index) => {
      const left = columns[index].getBoundingClientRect().right - bounds.left + 8;
      const right = columns[index + 1].getBoundingClientRect().left - bounds.left - 10;
      tracks.sort((a, b) => a.order - b.order || a.route.y1 - b.route.y1 || a.route.y2 - b.route.y2);
      tracks.forEach(({route, key}, lane) => {
        route[key] = left + (right - left) * (lane + 1) / (tracks.length + 1);
      });
    });

    const rows = [];
    const belowCards = Math.max(...columns.map(column => column.lastElementChild.getBoundingClientRect().bottom)) - bounds.top;
    longRoutes.sort((a, b) => a.start.batch - b.start.batch || a.end.batch - b.end.batch);
    for (const route of longRoutes) {
      let row = rows.findIndex(end => end < route.start.batch);
      if (row === -1) row = rows.length;
      rows[row] = route.end.batch;
      route.floor = belowCards + 15 + row * 11;
    }
    graph.style.paddingBottom = 16 + rows.length * 11 + 'px';

    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(graph.clientWidth * ratio);
    canvas.height = Math.ceil(graph.clientHeight * ratio);
    canvas.style.width = graph.clientWidth + 'px';
    canvas.style.height = graph.clientHeight + 'px';
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.lineJoin = 'round';
    for (const {edge, start, end, y1, y2, out, in: entry, floor} of routes) {
      const x2 = end.left - 2;
      context.strokeStyle = context.fillStyle = edge.to === selected ? '#376e9e' : '#34745e';
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(start.right, y1);
      context.lineTo(out, y1);
      if (floor !== undefined) {
        context.lineTo(out, floor);
        context.lineTo(entry, floor);
        context.lineTo(entry, y2);
      } else {
        context.lineTo(out, y2);
      }
      context.lineTo(x2, y2);
      context.stroke();
      context.beginPath();
      context.moveTo(x2, y2);
      context.lineTo(x2 - 6, y2 - 4);
      context.lineTo(x2 - 6, y2 + 4);
      context.fill();
    }
  }

  function select(id) {
    selected = id;
    for (const [taskId, button] of buttons) button.setAttribute('aria-pressed', String(id === taskId));
    reset.hidden = !id;
    if (!id) {
      const hidden = arrangement.edges.length - overview.length;
      explanation.textContent = '总览显示 ' + overview.length + ' 条连线。' +
        (hidden ? '另有 ' + hidden + ' 条可通过中间任务追溯。' : '') + '点击任务可查看它的全部直接依赖。';
      detail.replaceChildren();
      draw();
      return;
    }
    const count = arrangement.edges.filter(edge => edge.from === id || edge.to === id).length;
    explanation.textContent = id + ' 的 ' + count + ' 条连线 · 蓝色为前置依赖，绿色指向后续任务。';
    const task = tasksById.get(id);
    const card = taskCard(task, true);
    for (const [caption, here, other] of [
      ['前置任务', 'to', 'from'], ['后续任务', 'from', 'to'],
    ]) {
      card.append(element('h3', caption, 'dependency-heading'));
      const edges = arrangement.edges.filter(edge => edge[here] === id);
      if (!edges.length) {
        card.append(element('p', '无'));
        continue;
      }
      const relations = element('ul', '', 'dependency-list');
      for (const edge of edges) {
        const neighbor = tasksById.get(edge[other]);
        const button = element('button', neighbor.id + ' · ' + neighbor.title, 'task-link');
        button.type = 'button';
        button.addEventListener('click', () => {
          const node = buttons.get(neighbor.id);
          select(neighbor.id);
          node.scrollIntoView({block: 'nearest', inline: 'center'});
          node.focus({preventScroll: true});
        });
        const item = element('li');
        item.append(button, element('span', edgeReason(edge, tasksById.get(edge.to))));
        relations.append(item);
      }
      card.append(relations);
    }
    detail.replaceChildren(card);
    draw();
  }

  arrangement.rounds.forEach((ids, index) => {
    const column = element('section', '', 'column');
    column.append(element('h3', '第 ' + (index + 1) + ' 批'));
    for (const id of ids) {
      const button = taskCard(tasksById.get(id), false, true);
      button.id = 'node-' + id;
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => select(selected === id ? '' : id));
      buttons.set(id, button);
      column.append(button);
    }
    graph.append(column);
    columns.push(column);
  });
  view.append(scroll, detail);
  reset.addEventListener('click', () => {
    const node = buttons.get(selected);
    select('');
    node?.focus({preventScroll: true});
  });
  select(selected);
  observer = new ResizeObserver(draw);
  observer.observe(graph);
}

function render() {
  observer?.disconnect();
  tabs.forEach(button => button.setAttribute('aria-pressed', String(active === button.dataset.view)));
  view.replaceChildren();
  metrics();
  const tasks = new Map(result.plan.tasks.map(task => [task.id, task]));
  if (active === 'tasks') listTasks();
  if (active === 'graph') showGraph(tasks);
  if (active === 'rounds') showRounds(tasks);
  if (active === 'execution') monitor.renderExecution(view);
}

function edgeReason(edge, target) {
  return target.inputs.includes(edge.artifact) ? '需要交付物 ' + edge.artifact :
    '同一需求的测试等待交付物 ' + edge.artifact;
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const anchor = element('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

byId('download').addEventListener('click', () => {
  const feedback = result.pipeline && designFeedback(result.pipeline.design, result.plan, arrangement);
  downloadFile('se-workflow.json', JSON.stringify({...result, arrangement, designFeedback: feedback,
    observation: monitor.snapshot()}, null, 2),
    'application/json');
});

byId('report').addEventListener('click', () => {
  const {plan, model, mode} = result;
  const byTask = new Map(plan.tasks.map(task => [task.id, task]));
  const lines = [
    '# ' + plan.project + ' · 开发执行计划', '',
    '模型：' + model + '  ',
    '来源：' + (mode === 'live' ? '现场调用 DeepSeek API' : '导入的 DeepSeek 结果') + '  ',
    '并行上限：' + arrangement.capacity + ' 项／批', '',
    '## 需求与验收', '',
  ];
  for (const req of plan.requirements) {
    const links = plan.tasks.filter(task => task.requirements.includes(req.id)).map(task => task.id);
    lines.push('- **' + req.id + '** ' + req.text,
      '  - 验收：' + req.acceptance, '  - 关联任务：' + links.join('、'));
  }
  lines.push('', '## 开发任务', '');
  for (const task of plan.tasks) {
    lines.push('### ' + task.id + ' · ' + task.title, '',
      '- 角色：' + task.role, '- 关联需求：' + task.requirements.join('、'),
      '- 交付物：' + task.output, '- 验收：' + task.acceptance);
    if (result.pipeline) lines.push('- 设计来源：' + task.designs.join('、'));
    lines.push('');
  }
  lines.push('## 任务依赖', '');
  for (const edge of arrangement.edges) {
    lines.push('- ' + edge.from + ' → ' + edge.to + ' · ' + edgeReason(edge, byTask.get(edge.to)));
  }
  if (!arrangement.edges.length) lines.push('无前置任务。');
  lines.push('', '## 执行批次', '', '上一批全部完成后，下一批才开始。同批任务可并行。', '');
  arrangement.rounds.forEach((ids, index) => lines.push(
    '- 第 ' + (index + 1) + ' 批 · ' + ids.map(id => id + ' ' + byTask.get(id).title).join('、')));
  if (result.pipeline) {
    const {idea, requirements, design, testPlan} = result.pipeline;
    lines.push('', '## 原始产品想法', '', idea, '', '## 作业一需求规格的目标与范围', '',
      '- 目标：' + requirements.goal, '- 范围：' + requirements.scope, '', '## 编排回填到设计规格', '');
    for (const part of designFeedback(design, plan, arrangement)) {
      lines.push('### ' + part.id + ' · ' + part.title, '', '关联需求：' + part.requirements.join('、'));
      for (const task of part.tasks) {
        lines.push('- ' + task.id + ' · ' + task.title + ' · ' + task.role + ' · 第 ' + task.batch + ' 批',
          '  - 交付物：' + task.output, '  - 前置任务：' + (task.predecessors.join('、') || '无'),
          '  - 验收：' + task.acceptance);
      }
      lines.push('');
    }
    if (testPlan) {
      lines.push('## 测试方案', '', testPlan.strategy, '');
      for (const test of testPlan.cases) {
        const batch = arrangement.rounds.findIndex(ids => ids.includes(test.task)) + 1;
        lines.push('### ' + test.id + ' · ' + test.title, '',
          '关联：' + test.requirements.join('、') + ' → ' + test.design + ' → ' + test.task + ' · 第 ' + batch + ' 批',
          '', '前置条件：' + test.setup, '');
        test.steps.forEach((step, index) => lines.push((index + 1) + '. ' + step));
        lines.push('', '预期结果：' + test.expected, '');
      }
    }
  }
  lines.push('', result.pipeline ? '## 送入编排的设计规格' : '## 原始 Design Spec', '',
    ...result.spec.split(/\r?\n/).map(line => '> ' + line));
  downloadFile('开发执行计划.md', lines.join('\n') + '\n', 'text/markdown;charset=utf-8');
});

byId('startup').hidden = true;
for (const id of ['workspace', 'mast-actions', 'flow']) byId(id).hidden = false;
changeSpec();
void checkStatus();
