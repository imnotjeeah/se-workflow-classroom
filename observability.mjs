import {stateLabels, taskState, transition, rollbackScope, rollbackTask, validateDiscussion, validateRuntime} from './interaction.mjs';
import {testLevelLabels} from './workflow.mjs';

const actionLabels = {start:'开始执行',complete:'确认交付',ask:'请求补充',answer:'提交答复',fail:'报告失败',retry:'人工重试'};
actionLabels.rollback = '回退实现';
actionLabels.invalidated = '交付需重验';

function historyText(item) {
  return actionLabels[item.action] + (item.test ? ' · ' + item.test + ' → ' + item.target : '') + ' · ' + item.note;
}
const node = (tag, text = '', className = '') => {
  const item = document.createElement(tag);
  item.textContent = text;
  item.className = className;
  return item;
};
const button = (text, handler) => {
  const item = node('button', text);
  item.type = 'button';
  item.addEventListener('click', handler);
  return item;
};

export function createObservability({request, ready, adopt, getResult, getArrangement, download, isBusy, setBusy}) {
  let events = [], runtime = {}, discussion;
  const activity = document.getElementById('activity');
  const discussionResult = document.getElementById('discussion-result');
  const transcript = document.getElementById('transcript');
  const extract = document.getElementById('extract-discussion');
  const discussionError = document.getElementById('discussion-error');

  function log(stage, status, message, details = {}) {
    events.push({time: new Date().toISOString(), stage, status, message, ...details});
    renderActivity();
  }
  function renderActivity() {
    activity.replaceChildren(...events.slice(-100).reverse().map(event => {
      const row = node('li');
      row.append(node('time', new Date(event.time).toLocaleTimeString('zh-CN')),
        node('strong', event.stage + ' · ' + event.status), node('span', event.message));
      return row;
    }));
    document.getElementById('event-count').textContent = events.length + ' 条记录';
  }

  extract.addEventListener('click', async () => {
    if (isBusy()) return;
    discussionError.textContent = '';
    if (transcript.value.trim().length < 15) {
      discussionError.textContent = '请填写至少 15 字的讨论记录。';
      return;
    }
    if (!await ready()) return;
    extract.disabled = transcript.disabled = true;
    setBusy(true);
    const source = transcript.value;
    try {
      const response = await request('discussion', {transcript: source});
      discussion = {transcript: source, ...response.discussion, confirmed: false};
      renderDiscussion();
    } catch (error) {
      discussionError.textContent = error.message;
    } finally {
      extract.disabled = transcript.disabled = false;
      setBusy(false);
    }
  });
  transcript.addEventListener('input', () => {
    discussion = undefined;
    discussionResult.replaceChildren();
  });
  document.getElementById('discussion-example').addEventListener('click', () => {
    if (isBusy() || transcript.disabled) return;
    transcript.value = '产品同学：先做多人旅游行程网页，每天最多 8 小时。\n前端 Agent：我建议先支持手工录入景点名称和时长。\n后端 Agent：同意。每个景点只能排一次，排不下的单独列出来。\n测试同学：景点拖到另一天超时，是拒绝还是允许警告后保存？\n产品同学：这个还需要确认。';
    discussion = undefined;
    discussionResult.replaceChildren();
  });

  function renderDiscussion() {
    discussionResult.replaceChildren();
    if (!discussion) return;
    discussionResult.append(node('h3', '讨论 → 要点 → 共同理解草稿'));
    const original = node('details');
    original.append(node('summary', '查看带行号的讨论原文'),
      node('pre', discussion.transcript.split(/\r?\n/).map((line,i) => (i+1) + '  ' + line).join('\n'), 'transcript-source'));
    discussionResult.append(original);
    const inputs = new Map();
    for (const point of discussion.points) {
      const card = node('article', '', 'chain-card');
      card.append(node('h4', point.id + ' · ' + (point.kind === 'open' ? '待确认' : '明确意见')),
        node('p', point.text));
      for (const evidence of point.evidence) card.append(node('blockquote', '第 ' + evidence.line + ' 行 · ' + evidence.quote));
      if (point.kind === 'open') {
        const label = node('label', '负责人处理决定');
        const input = node('input');
        input.maxLength = 500;
        input.value = discussion.resolutions?.[point.id] || '';
        input.disabled = discussion.confirmed;
        label.append(input);
        card.append(label);
        inputs.set(point.id, input);
      }
      discussionResult.append(card);
    }
    const label = node('label', '共同理解草稿（可修改）');
    const mainline = node('textarea');
    mainline.value = discussion.confirmedText || discussion.mainline;
    mainline.maxLength = 2000;
    mainline.disabled = discussion.confirmed;
    label.append(mainline);
    const confirm = button(discussion.confirmed ? '负责人已确认' : '确认并转入产品想法', () => {
      if (isBusy()) return;
      const resolutions = Object.fromEntries([...inputs].map(([id,input]) => [id,input.value.trim()]));
      if (!mainline.value.trim() || Object.values(resolutions).some(value => !value)) {
        discussionError.textContent = '请先填写共同理解，并处理所有待确认问题。';
        return;
      }
      const text = [mainline.value.trim(), ...Object.entries(resolutions).map(([id,value]) =>
        '负责人对 ' + id + ' 的确认：' + value)].join('\n');
      if (text.length > 4000 || text.length < 15) {
        discussionError.textContent = '确认后的产品想法需在 15 至 4000 字之间，请调整主线或决定。';
        return;
      }
      const saved = {...discussion, resolutions, confirmedText: mainline.value.trim(), confirmed: true};
      adopt(text);
      discussion = saved;
      log('讨论确认', '人工确认', '共同理解及 ' + Object.keys(resolutions).length + ' 项分歧处理已转入产品想法');
      discussionError.textContent = '';
      renderDiscussion();
    });
    confirm.disabled = discussion.confirmed;
    discussionResult.append(label, confirm);
  }

  function renderExecution(container) {
    const {plan} = getResult();
    const arrangement = getArrangement();
    const tasks = new Map(plan.tasks.map(task => [task.id, task]));
    container.append(node('p', '任务执行由负责人或外部 Agent 完成，在此提交进度与交付记录。完成前置任务后，后续任务才可开始。', 'hint'));
    for (const task of plan.tasks) {
      const state = taskState(task.id, runtime, arrangement);
      const card = node('article', '', 'execution-card');
      card.append(node('h3', task.id + ' · ' + task.title),
        node('p', task.role + ' · ' + stateLabels[state] + ' · 尝试 ' + (runtime[task.id]?.attempts || 0) + ' 次', 'execution-status'),
        node('p', '预期交付物：' + task.output),
        node('p', '前置：' + (arrangement.dependencies[task.id].map(id => id + ' ' + stateLabels[taskState(id, runtime, arrangement)]).join('、') || '无')));
      if (task.test) card.append(node('p', '测试目标：' + task.test.targets
        .map(id => id + ' ' + tasks.get(id).title).join('、')));
      const list = node('ul', '', 'execution-history');
      for (const item of runtime[task.id]?.notes || []) list.append(node('li',
        new Date(item.time).toLocaleTimeString('zh-CN') + ' · ' + historyText(item)));
      if (list.childElementCount) card.append(list);
      const allowed = {ready:['start'],running:['ask','fail','complete'],waiting:['answer'],failed:['retry']}[state] || [];
      if (allowed.length) {
        const label = node('label', '处理说明／交付物位置');
        const note = node('textarea');
        note.rows = 2;
        note.maxLength = 2000;
        label.append(note);
        const actions = node('div', '', 'execution-actions');
        const error = node('p', '', 'error');
        error.setAttribute('role','alert');
        for (const action of allowed) actions.append(button(actionLabels[action], () => {
          try {
            runtime[task.id] = transition(task.id, action, note.value, runtime, arrangement);
            log(task.id, actionLabels[action], note.value.trim());
            container.replaceChildren();
            renderExecution(container);
          } catch (issue) { error.textContent = issue.message; }
        }));
        if (state === 'failed' && task.test) {
          const targetLabel = node('label', '回退目标');
          const targets = node('select');
          targets.append(new Option('选定确认有缺陷的实现任务', ''));
          for (const id of task.test.targets) targets.append(new Option(id + ' · ' + tasks.get(id).title, id));
          if (task.test.targets.length === 1) targets.value = task.test.targets[0];
          targetLabel.append(targets);
          const impact = node('p', '', 'hint');
          const rollback = button('回退并要求重验', () => {
            try {
              const id = targets.value;
              const update = rollbackTask(task, id, note.value, runtime, arrangement);
              runtime = update.runtime;
              log(task.id, '回退到 ' + id, note.value.trim() + '。需重新验证：' + update.affected.join('、'),
                {rollbackTarget: id, affected: update.affected});
              container.replaceChildren();
              renderExecution(container);
            } catch (issue) { error.textContent = issue.message; }
          });
          const showImpact = () => {
            rollback.disabled = !targets.value;
            impact.textContent = targets.value ? '修复 ' + targets.value + ' 后重新验证 ' +
              rollbackScope(targets.value, arrangement).join('、') + '。' : '选定实现任务后可预览影响范围。';
          };
          targets.addEventListener('change', showImpact);
          showImpact();
          card.append(targetLabel, impact);
          actions.append(rollback);
        }
        card.append(label, actions, error);
      }
      container.append(card);
    }
  }

  document.getElementById('export-task-md').addEventListener('click', () => {
    const result = getResult();
    if (!result) return;
    const arrangement = getArrangement();
    const lines = ['# ' + result.plan.project + ' · task.md', '', '任务执行记录由负责人填写。', ''];
    for (const task of result.plan.tasks) {
      lines.push('## ' + task.id + ' · ' + task.title, '',
        '- 工种：' + task.role, '- 需求：' + task.requirements.join('、'),
        '- 设计：' + (task.designs?.join('、') || '已有设计规格'),
        '- 输入：' + (task.inputs.join('、') || '设计规格'),
        '- 前置任务：' + (arrangement.dependencies[task.id].join('、') || '无'),
        '- 交付物：' + task.output, '- 验收：' + task.acceptance,
        '- 执行状态：' + stateLabels[taskState(task.id, runtime, arrangement)], '');
      if (task.test) lines.push('- 测试层次：' + testLevelLabels[task.test.level],
        '- 验证及失败定位范围：' + task.test.targets.join('、'));
      for (const item of runtime[task.id]?.notes || []) lines.push('- ' + historyText(item));
      lines.push('');
    }
    download('task.md', lines.join('\n'), 'text/markdown;charset=utf-8');
  });
  document.getElementById('export-activity').addEventListener('click', () => {
    download('运行与交互记录.json', JSON.stringify({events, runtime, discussion},null,2), 'application/json');
  });
  return {
    log, renderExecution,
    reset() { events = []; runtime = {}; discussion = undefined; discussionResult.replaceChildren(); renderActivity(); },
    resetRuntime() { runtime = {}; },
    snapshot() { return structuredClone({events, runtime, discussion}); },
    restore(value, plan, arrangement) {
      const restored = value || {events:[], runtime:{}};
      if (!Array.isArray(restored.events) || restored.events.length > 10000 ||
          restored.events.some(event => typeof event.stage !== 'string' || typeof event.message !== 'string' ||
            typeof event.status !== 'string' || typeof event.time !== 'string')) throw new Error('运行日志格式无效');
      validateRuntime(restored.runtime, plan, arrangement);
      if (restored.discussion) {
        if (typeof restored.discussion.transcript !== 'string') throw new Error('讨论原文无效');
        validateDiscussion(restored.discussion, restored.discussion.transcript);
      }
      events = restored.events; runtime = restored.runtime; discussion = restored.discussion;
      if (discussion) transcript.value = discussion.transcript;
      renderActivity(); renderDiscussion();
    },
  };
}
