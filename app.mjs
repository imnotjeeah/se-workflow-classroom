import { examples } from './examples.mjs';
import { schedule } from './workflow.mjs';

const byId = id => document.getElementById(id);
const directFile = location.protocol === 'file:';
const apiBase = directFile ? 'http://127.0.0.1:8765' : '';
const spec = byId('spec');
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

function element(tag, content = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = content;
  node.className = className;
  return node;
}

example.add(new Option('自定义规格', ''));
examples.forEach(({name}, index) => example.add(new Option(name, String(index))));
for (let n = 1; n <= 8; n++) capacity.add(new Option(String(n), String(n)));
capacity.value = '4';

function updateInput() {
  byId('count').textContent = spec.value.length + ' / 4000';
  const match = examples.findIndex(item => item.spec === spec.value);
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

function changeSpec() {
  result = undefined;
  updateInput();
  statusMessage('等待运行工作流', '选择案例或输入规格，查看任务分解和依赖关系。');
}
spec.value = examples[0].spec;
updateInput();
spec.addEventListener('input', changeSpec);
example.addEventListener('change', () => {
  spec.value = examples[example.value]?.spec ?? '';
  changeSpec();
  if (!example.value) spec.focus();
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
  for (const control of [spec, example, capacity, file, replay, run]) control.disabled = value;
  notice.classList.toggle('busy', value);
  run.textContent = value ? '正在生成…' : '运行工作流 ↗';
}

run.addEventListener('click', async () => {
  if (busy) return;
  if (spec.value.trim().length < 15) {
    byId('input-error').textContent = '请输入至少 15 字的设计规格。';
    spec.focus();
    return;
  }
  if (!apiStatus) await checkStatus();
  if (busy) return;
  if (!apiStatus) {
    byId('input-error').textContent = '生成服务未连接。启动后再点一次「运行工作流」。';
    return;
  }
  if (!pageKey && (directFile || !apiStatus.configured)) {
    openKeyDialog();
    return;
  }
  result = undefined;
  byId('input-error').textContent = '';
  lock(true);
  statusMessage('PM Agent 正在分解任务', 'DeepSeek 正在提取需求和交付物。校验通过后，编排器会生成依赖和执行批次。');
  try {
    const response = await fetch(apiBase + '/api/decompose', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({spec: spec.value, apiKey: pageKey}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    show({...data, spec: spec.value});
  } catch (error) {
    statusMessage('生成失败', error.message);
    if (error instanceof TypeError) await checkStatus();
  } finally {
    lock(false);
  }
});

replay.addEventListener('change', async () => {
  const chosen = replay.files[0];
  replay.value = '';
  if (!chosen) return;
  try {
    if (chosen.size > 1024 * 1024) throw new Error('结果文件最多 1 MB。');
    const {provider, spec: source, plan, model, generatedAt} = JSON.parse(await chosen.text());
    if (busy) return;
    if (provider !== 'deepseek' || typeof source !== 'string' || source.trim().length < 15 ||
        source.length > 4000 || typeof model !== 'string' || !model.trim()) {
      throw new Error('请选择此工作台导出的 DeepSeek 结果 JSON。');
    }
    show({provider, spec: source, plan, model, generatedAt, mode: 'imported'});
    spec.value = source;
    updateInput();
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
  render();
});
tabs.forEach(button => button.addEventListener('click', () => {
  active = button.dataset.view;
  render();
}));

byId('go-spec').addEventListener('click', () => {
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
                + '<span style="color:#0b654c; font-weight:bold; font-size:14px;">🤖 AI Coder Agent</span>'
                + '<span style="background:#e9f3ed; color:#0b654c; font-size:12px; padding:2px 8px; border-radius:12px; border:1px solid #c2dfd3;">已通过语法检查 ✅</span>'
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
      
      codeEl.innerHTML = codeEl.textContent
        .replace(/(import|from|const|await|async|return|try|catch|export|default)/g, '<span style="color:#8250df; font-weight:bold;">$1</span>')
        .replace(/('[^']*')/g, '<span style="color:#b35900;">$1</span>')
        .replace(/(\/\/.*)/g, '<span style="color:#1a7f37;">$1</span>')
        .replace(/(executeCoreTask|create|console|log|json)/g, '<span style="color:#0550ae;">$1</span>');
        
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
      locate.addEventListener('click', () => {
        selected = task.id;
        openResults('graph');
        const node = byId('node-' + task.id);
        node.scrollIntoView({block: 'nearest', inline: 'center'});
        node.focus({preventScroll: true});
      });
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

function showGraph(tasksById) {
  view.append(element('p', '箭头从交付物生产任务指向使用任务。测试会等待同一需求下的非测试任务。选中节点可查看详情。', 'hint'));
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

  function draw() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.ceil(graph.clientWidth * ratio);
    canvas.height = Math.ceil(graph.clientHeight * ratio);
    canvas.style.width = graph.clientWidth + 'px';
    canvas.style.height = graph.clientHeight + 'px';
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    const bounds = graph.getBoundingClientRect();
    for (const {from, to} of arrangement.edges) {
      const start = buttons.get(from).getBoundingClientRect();
      const end = buttons.get(to).getBoundingClientRect();
      const x1 = start.right - bounds.left;
      const y1 = start.top + start.height / 2 - bounds.top;
      const x2 = end.left - bounds.left - 2;
      const y2 = end.top + end.height / 2 - bounds.top;
      const bend = Math.min((x2 - x1) / 2, 23);
      const color = !selected || selected === from || selected === to ? '#29735c' : '#b4c9bd';
      context.strokeStyle = context.fillStyle = color;
      context.lineWidth = 1.6;
      context.beginPath();
      context.moveTo(x1, y1);
      context.bezierCurveTo(x1 + bend, y1, x2 - bend, y2, x2, y2);
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
      button.addEventListener('click', () => select(id));
      buttons.set(id, button);
      column.append(button);
    }
    graph.append(column);
  });
  view.append(scroll, detail);
  if (selected) select(selected);
  else detail.append(element('p', '点击任意任务查看详情。', 'hint'));
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
  downloadFile('se-workflow.json', JSON.stringify({...result, arrangement}, null, 2), 'application/json');
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
      '- 交付物：' + task.output, '- 验收：' + task.acceptance, '');
  }
  lines.push('## 任务依赖', '');
  for (const edge of arrangement.edges) {
    lines.push('- ' + edge.from + ' → ' + edge.to + ' · ' + edgeReason(edge, byTask.get(edge.to)));
  }
  if (!arrangement.edges.length) lines.push('无前置任务。');
  lines.push('', '## 执行批次', '', '上一批全部完成后，下一批才开始。同批任务可并行。', '');
  arrangement.rounds.forEach((ids, index) => lines.push(
    '- 第 ' + (index + 1) + ' 批 · ' + ids.map(id => id + ' ' + byTask.get(id).title).join('、')));
  lines.push('', '## 原始 Design Spec', '', ...result.spec.split(/\r?\n/).map(line => '> ' + line));
  downloadFile('开发执行计划.md', lines.join('\n') + '\n', 'text/markdown;charset=utf-8');
});

byId('startup').hidden = true;
for (const id of ['workspace', 'mast-actions', 'flow']) byId(id).hidden = false;
void checkStatus();