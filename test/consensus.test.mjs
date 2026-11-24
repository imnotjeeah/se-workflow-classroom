import assert from 'node:assert/strict';
import test from 'node:test';
import {acknowledgedAll, confirmConsensus, discussionParticipants, registerStance, startConsensusRound,
  validateConsensus} from '../consensus.mjs';

test('only unanimous agreement in the same round can confirm a revised proposal', () => {
  const people = discussionParticipants('产品：提出方案\n测试 Agent:提出异议\n产品：补充说明');
  assert.deepEqual(people, ['产品','测试 Agent']);
  const draft = {participants: people, points: [{id:'P1', kind:'open'}]};
  const proposal = '安排景点并允许同行人员调整行程';
  let current = startConsensusRound(draft, {participants:people, proposal, resolutions:{P1:'允许超时保存'}});
  const agree = (target, participant) => registerStance(target, {participant, stance:'agree', note:''});
  current = agree(current, '产品');
  assert.throws(() => agree(current, '产品'), /已有记录/);
  assert.throws(() => registerStance(current, {participant:'测试 Agent', stance:'object', point:'P1', note:''}), /填写意见/);
  current = registerStance(current, {participant:'测试 Agent', stance:'object', point:'P1', note:'应拒绝超时'});
  assert.throws(() => confirmConsensus(current), /全体/);
  const revision = {proposal, resolutions:{P1:'拒绝超时并提示原因'}};
  assert.throws(() => startConsensusRound(current, revision), /回应/);
  const revised = startConsensusRound(current, {...revision, responses:{'测试 Agent':'采纳，补充超时拒绝说明'}});
  assert.deepEqual(revised.rounds[0], current.rounds[0]);
  assert.equal(revised.rounds[1].votes.length, 0);
  assert.throws(() => confirmConsensus(agree(revised, '测试 Agent')), /全体/);
  const accepted = agree(agree(revised, '测试 Agent'), '产品');
  assert(acknowledgedAll(accepted));
  const final = confirmConsensus(accepted);
  assert.match(final.text, /P1 的共识决定：拒绝超时并提示原因/);
  assert.doesNotThrow(() => validateConsensus(JSON.parse(JSON.stringify(final.discussion))));
  assert.throws(() => validateConsensus({...final.discussion, confirmedRound:1}), /不一致/);
  assert.doesNotThrow(() => validateConsensus({mainline:proposal, confirmed:true}));
});
