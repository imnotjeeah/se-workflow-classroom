export const stateLabels = {
  pending: '等待前置', ready: '可开始', running: '执行中', waiting: '等待人工补充',
  failed: '失败待处理', done: '已确认完成',
};

export function taskState(id, runtime, arrangement) {
  const saved = runtime[id];
  if (saved && saved.status !== 'pending') return saved.status;
  return arrangement.dependencies[id].every(parent => runtime[parent]?.status === 'done') ? 'ready' : 'pending';
}

export function transition(id, action, note, runtime, arrangement) {
  if (!Object.hasOwn(arrangement.dependencies, id)) throw new Error('任务不存在');
  const state = taskState(id, runtime, arrangement);
  const allowed = {
    start: ['ready'], complete: ['running'], ask: ['running'], fail: ['running'],
    answer: ['waiting'], retry: ['failed'],
  };
  if (!allowed[action]?.includes(state)) throw new Error('当前状态不支持这项操作');
  if (typeof note !== 'string' || !note.trim() || note.length > 2000) throw new Error('请填写处理说明，完成时填写交付物位置或结果摘要');
  const next = {start: 'running', complete: 'done', ask: 'waiting', fail: 'failed', answer: 'running', retry: 'running'};
  const record = runtime[id] ?? {status: 'pending', attempts: 0, notes: []};
  return {...record, status: next[action], attempts: record.attempts + Number(action === 'start' || action === 'retry'),
    notes: [...record.notes, {action, note: note.trim(), time: new Date().toISOString()}]};
}

export function validateDiscussion(value, transcript) {
  const lines = transcript.split(/\r?\n/);
  if (typeof value?.mainline !== 'string' || !value.mainline.trim() || value.mainline.length > 2000 ||
      !Array.isArray(value.points) || !value.points.length || value.points.length > 12) {
    throw new Error('讨论摘要需要主线和 1 至 12 条要点');
  }
  const ids = new Set();
  for (const point of value.points) {
    if (!/^P[1-9]\d*$/.test(point?.id) || ids.has(point.id) || !['decision','open'].includes(point.kind) ||
        typeof point.text !== 'string' || !point.text.trim() || point.text.length > 1000 ||
        !Array.isArray(point.evidence) || !point.evidence.length) throw new Error('讨论要点格式或编号无效');
    ids.add(point.id);
    for (const source of point.evidence) {
      if (!Number.isInteger(source.line) || typeof source.quote !== 'string' || !source.quote.trim() ||
          !lines[source.line - 1]?.includes(source.quote)) throw new Error(point.id + ' 的证据未在对应原文行中找到');
    }
  }
}

export function validateRuntime(runtime, plan, arrangement) {
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('任务状态无效');
  const ids = new Set(plan.tasks.map(task => task.id));
  for (const [id, record] of Object.entries(runtime)) {
    if (!ids.has(id) || !['pending','running','waiting','failed','done'].includes(record.status) ||
        !Number.isInteger(record.attempts) || record.attempts < 0 || !Array.isArray(record.notes) ||
        record.notes.length > 1000 || record.notes.some(item => typeof item.note !== 'string' || item.note.length > 2000)) {
      throw new Error('导入的执行记录无效');
    }
    if (record.status !== 'pending' && arrangement.dependencies[id].some(parent => runtime[parent]?.status !== 'done')) {
      throw new Error('执行记录与前置任务状态不一致');
    }
  }
}
