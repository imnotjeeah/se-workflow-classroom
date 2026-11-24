export const stanceLabels = {agree: '同意', object: '反对', reserve: '保留意见'};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanText(value, limit, message) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= limit, message);
  return value.trim();
}

export function discussionParticipants(transcript) {
  const names = transcript.split(/\r?\n/).map(line => /^\s*([^：:\r\n]{1,50})[：:]/.exec(line)?.[1].trim());
  return [...new Set(names.filter(Boolean))];
}

export function acknowledgedAll(discussion) {
  const round = discussion.rounds?.at(-1);
  return Boolean(round && discussion.participants.every(name =>
    round.votes.some(vote => vote.participant === name && vote.stance === 'agree')));
}

function proposalText(round) {
  return [round.proposal, ...Object.entries(round.resolutions).map(([id, answer]) =>
    id + ' 的共识决定：' + answer)].join('\n');
}

export function startConsensusRound(discussion, {participants, proposal, resolutions, responses}) {
  requireValue(!discussion.confirmed, '共同理解已经确认');
  const history = discussion.rounds ?? [];
  requireValue(history.length < 40, '讨论记录最多支持 40 轮');
  const previous = history.at(-1);
  const names = previous ? discussion.participants : participants;
  requireValue(Array.isArray(names) && names.length >= 2 && names.length <= 30, '请登记 2 至 30 位参与者');
  const roster = names.map(name => cleanText(name, 50, '参与者名称需在 1 至 50 字之间'));
  requireValue(new Set(roster).size === roster.length, '参与者名称须唯一');
  const summary = cleanText(proposal, 2000, '请填写本轮决策提案，最多 2000 字');
  const decisions = Object.fromEntries(discussion.points.filter(point => point.kind === 'open').map(point => [
    point.id, cleanText(resolutions?.[point.id], 500, '请填写 ' + point.id + ' 的拟议决定，最多 500 字'),
  ]));
  const objections = (previous?.votes ?? []).filter(vote => vote.stance !== 'agree');
  const replies = Object.fromEntries(objections.map(vote => [vote.participant,
    cleanText(Object.hasOwn(responses ?? {}, vote.participant) ? responses[vote.participant] : undefined,
      500, '请先回应 ' + vote.participant + ' 的意见，最多 500 字')]));
  const round = {
    number: history.length + 1, proposal: summary, resolutions: decisions, responses: replies,
    votes: [], openedAt: new Date().toISOString(),
  };
  const input = proposalText(round);
  requireValue(input.length >= 15 && input.length <= 4000, '提案与分歧处理合计需在 15 至 4000 字之间');
  return {...discussion, participants: roster, rounds: [...history, round]};
}

export function registerStance(discussion, {participant, stance, point, note}) {
  const round = discussion.rounds?.at(-1);
  requireValue(round && !discussion.confirmed, '请先开启可登记的确认轮次');
  requireValue(discussion.participants.includes(participant), '请选择本轮参与者');
  requireValue(Object.hasOwn(stanceLabels, stance), '请选择立场');
  requireValue(!round.votes.some(vote => vote.participant === participant), '这位参与者在本轮已有记录');
  const pointId = stance === 'agree' ? '' : point;
  requireValue(pointId === '' || discussion.points.some(item => item.id === pointId), '请选择有效的讨论要点');
  const reason = stance === 'agree' && typeof note === 'string' && !note.trim()
    ? '' : cleanText(note, 500, '请填写意见，最多 500 字');
  const vote = {participant, stance, point: pointId, note: reason, time: new Date().toISOString()};
  return {...discussion, rounds: [...discussion.rounds.slice(0, -1), {...round, votes: [...round.votes, vote]}]};
}

export function confirmConsensus(discussion) {
  requireValue(!discussion.confirmed && acknowledgedAll(discussion), '本轮全体参与者同意后才可确认共识');
  const round = discussion.rounds.at(-1);
  return {text: proposalText(round), discussion: {...discussion, confirmed: true,
    confirmedText: round.proposal, resolutions: round.resolutions, confirmedRound: round.number}};
}

export function validateConsensus(record) {
  if (record.rounds === undefined) return;
  requireValue(Array.isArray(record.rounds) && record.rounds.length > 0, '轮次记录无效');
  let replay = {...record, rounds: [], confirmed: false};
  for (const saved of record.rounds) {
    requireValue(saved?.number === replay.rounds.length + 1 && Array.isArray(saved.votes) &&
      typeof saved.openedAt === 'string', '轮次记录无效');
    replay = startConsensusRound(replay, {
      participants: record.participants, proposal: saved.proposal,
      resolutions: saved.resolutions, responses: saved.responses,
    });
    for (const vote of saved.votes) {
      requireValue(typeof vote?.time === 'string' && typeof vote.note === 'string', '立场记录无效');
      replay = registerStance(replay, vote);
    }
  }
  if (record.confirmed) {
    const final = confirmConsensus(replay).discussion;
    requireValue(record.confirmedRound === final.confirmedRound && record.confirmedText === final.confirmedText,
      '共识确认与最后一轮立场不一致');
  }
}
