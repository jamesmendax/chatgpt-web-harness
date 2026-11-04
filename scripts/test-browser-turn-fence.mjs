import assert from 'node:assert/strict';
import { beginBrowserTurnFence, observeBrowserTurnFence } from '../dist/lib/browser-turn-fence.js';

const snap = (overrides = {}) => ({
  tab_id: 'tab-a',
  observed_at_ms: 1_000,
  user_turn_count: 1,
  assistant_turn_count: 1,
  generation_active: false,
  tool_inflight_count: 0,
  activity_revision: 10,
  visible_text_hash: 'h0',
  ...overrides,
});

{
  let state = beginBrowserTurnFence('session-a', snap(), { ambiguity_ms: 2_000, stable_ms: 200 });
  const ambiguous = observeBrowserTurnFence(state, snap({ observed_at_ms: 3_100 }));
  assert.equal(ambiguous.phase, 'send_ambiguous');
  assert.equal(ambiguous.next_action, 'rebind_same_tab');
  assert.equal(ambiguous.resubmit_allowed, false);
}

{
  let state = beginBrowserTurnFence('session-a', snap(), { stable_ms: 200 });
  const accepted = observeBrowserTurnFence(state, snap({ observed_at_ms: 1_100, generation_active: true }));
  assert.equal(accepted.state.accepted, true);
  assert.equal(accepted.state.acceptance_reason, 'generation');
  assert.equal(accepted.phase, 'running');
}

{
  let state = beginBrowserTurnFence('session-a', snap(), { stable_ms: 200 });
  let decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 1_100, activity_revision: 11, tool_inflight_count: 1 }));
  assert.equal(decision.state.acceptance_reason, 'mcp_activity');
  assert.equal(decision.phase, 'running');
  state = decision.state;

  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 1_300, activity_revision: 11, assistant_turn_count: 2, visible_text_hash: 'h1' }));
  assert.equal(decision.phase, 'candidate_complete');
  state = decision.state;

  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 1_550, activity_revision: 12, assistant_turn_count: 2, visible_text_hash: 'h1' }));
  assert.equal(decision.phase, 'accepted');
  assert.equal(decision.state.completed, false);
  state = decision.state;

  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 1_800, activity_revision: 12, assistant_turn_count: 2, visible_text_hash: 'h1' }));
  assert.equal(decision.phase, 'accepted', 'pre-tool answer must not complete a later tool batch');
  state = decision.state;
  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 1_850, activity_revision: 12, assistant_turn_count: 2, visible_text_hash: 'post-tool-answer' }));
  assert.equal(decision.phase, 'candidate_complete');
  state = decision.state;
  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 2_100, activity_revision: 12, assistant_turn_count: 2, visible_text_hash: 'post-tool-answer' }));
  assert.equal(decision.phase, 'complete');
  assert.equal(decision.state.completed, true);
}

{
  const state = beginBrowserTurnFence('session-a', snap());
  const wrongTab = observeBrowserTurnFence(state, snap({ tab_id: 'tab-b', observed_at_ms: 1_100, user_turn_count: 2 }));
  assert.equal(wrongTab.phase, 'wrong_tab');
  assert.equal(wrongTab.next_action, 'rebind_same_tab');
  assert.equal(wrongTab.resubmit_allowed, false);
}

{
  let state = beginBrowserTurnFence('session-a', snap(), { stable_ms: 200 });
  state = observeBrowserTurnFence(state, snap({ observed_at_ms: 1300, generation_active: true, activity_revision: 12 })).state;
  const stale = observeBrowserTurnFence(state, snap({ observed_at_ms: 1200, activity_revision: 11, assistant_turn_count: 2 }));
  assert.equal(stale.state.completed, false);
  assert.equal(stale.state.last_snapshot.activity_revision, 12);
  assert.equal(stale.resubmit_allowed, false);
}

{
  let state = beginBrowserTurnFence('session-a', snap(), { stable_ms: 200 });
  for (const time of [1200, 1500, 1900]) {
    const waiting = observeBrowserTurnFence(state, snap({ observed_at_ms: time, user_turn_count: 2 }));
    assert.equal(waiting.phase, 'accepted', 'user send alone cannot prove an assistant answer completed');
    assert.equal(waiting.state.completed, false);
    state = waiting.state;
  }
}
{
  let state = beginBrowserTurnFence('session-error', snap(), { stable_ms: 200 });
  state = observeBrowserTurnFence(state, snap({ observed_at_ms: 1100, user_turn_count: 2, generation_active: true })).state;
  let decision;
  for (const time of [1300, 1600]) {
    decision = observeBrowserTurnFence(state, snap({ observed_at_ms: time, user_turn_count: 2,
      assistant_turn_count: 2, visible_text_hash: 'stream-recovery-timeout', failure_visible: true }));
    state = decision.state;
  }
  assert.equal(decision.phase, 'delivery_failed', 'stable native delivery-error text must not be successful completion');
  assert.equal(state.completed, false);
  assert.equal(state.completion_candidate, null);
  assert.equal(decision.resubmit_allowed, false);

  for (const time of [1900, 2200]) {
    decision = observeBrowserTurnFence(state, snap({ observed_at_ms: time, user_turn_count: 2,
      assistant_turn_count: 2, visible_text_hash: 'error-banner-disappeared', failure_visible: false }));
    assert.equal(decision.phase, 'delivery_failed', 'removing an error banner is not new assistant response evidence');
    assert.equal(decision.state.completed, false);
    state = decision.state;
  }

  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 2300, user_turn_count: 2,
    assistant_turn_count: 2, generation_active: true, visible_text_hash: 'new-generation', failure_visible: false }));
  assert.equal(decision.phase, 'running', 'positive fresh generation can clear the failure latch without resubmitting');
  state = decision.state;
  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 2500, user_turn_count: 2,
    assistant_turn_count: 3, visible_text_hash: 'fresh-real-answer', failure_visible: false }));
  assert.equal(decision.phase, 'candidate_complete');
  state = decision.state;
  decision = observeBrowserTurnFence(state, snap({ observed_at_ms: 2800, user_turn_count: 2,
    assistant_turn_count: 3, visible_text_hash: 'fresh-real-answer', failure_visible: false }));
  assert.equal(decision.phase, 'complete');
  assert.equal(decision.resubmit_allowed, false);

  decision = observeBrowserTurnFence(decision.state, snap({ observed_at_ms: 3000, user_turn_count: 2,
    assistant_turn_count: 3, visible_text_hash: 'late-delivery-error', failure_visible: true }));
  assert.equal(decision.phase, 'delivery_failed', 'a fresh failure must revoke a previously completed observation');
  assert.equal(decision.state.completed, false);
}

{
  let state = beginBrowserTurnFence('session-candidate', snap(), { stable_ms: 200 });
  state = observeBrowserTurnFence(state, snap({ observed_at_ms: 1100, user_turn_count: 2,
    assistant_turn_count: 2, visible_text_hash: 'candidate-answer' })).state;
  assert.ok(state.completion_candidate);
  const failed = observeBrowserTurnFence(state, snap({ observed_at_ms: 1400, user_turn_count: 2,
    assistant_turn_count: 2, visible_text_hash: 'candidate-answer', failure_visible: true }));
  assert.equal(failed.phase, 'delivery_failed', 'failure status must take precedence even when the text hash is unchanged');
  assert.equal(failed.state.completion_candidate, null);
}

{
  const state = beginBrowserTurnFence('session-unaccepted-error', snap());
  const failed = observeBrowserTurnFence(state, snap({ observed_at_ms: 1200, failure_visible: true }));
  assert.equal(failed.phase, 'delivery_failed');
  assert.equal(failed.state.accepted, false, 'an error alone must not prove that a send was accepted');
  assert.equal(failed.resubmit_allowed, false);
}

{
  let state = beginBrowserTurnFence('session-stale-error', snap());
  state = observeBrowserTurnFence(state, snap({ observed_at_ms: 1500, user_turn_count: 2, generation_active: true })).state;
  const wrongTab = observeBrowserTurnFence(state, snap({ tab_id: 'other-tab', observed_at_ms: 1600, failure_visible: true }));
  assert.equal(wrongTab.phase, 'wrong_tab');
  assert.equal(wrongTab.state, state);
  const stale = observeBrowserTurnFence(state, snap({ observed_at_ms: 1400, failure_visible: true }));
  assert.equal(stale.state.last_snapshot, state.last_snapshot, 'stale error reads cannot change the current tab state');
  assert.equal(stale.resubmit_allowed, false);
}

{
  let state = beginBrowserTurnFence('session-tool-after-error', snap());
  state = observeBrowserTurnFence(state, snap({ observed_at_ms: 1100, user_turn_count: 2,
    assistant_turn_count: 2, visible_text_hash: 'error', failure_visible: true })).state;
  for (const [time, inflight] of [[1300, 1], [1500, 0]]) {
    const decision = observeBrowserTurnFence(state, snap({ observed_at_ms: time, user_turn_count: 2,
      assistant_turn_count: 2, activity_revision: 11, tool_inflight_count: inflight,
      visible_text_hash: 'cleared-plus-tool-activity', failure_visible: false }));
    assert.equal(decision.phase, 'delivery_failed', 'tool progress alone is not successful answer delivery');
    state = decision.state;
  }
  const freshReply = observeBrowserTurnFence(state, snap({ observed_at_ms: 1600, user_turn_count: 2,
    assistant_turn_count: 3, activity_revision: 11, visible_text_hash: 'new-assistant', failure_visible: false }));
  assert.equal(freshReply.phase, 'candidate_complete', 'a genuinely new assistant turn can independently clear the latch');
}

{
  const legacy = beginBrowserTurnFence('old-checkpoint', snap());
  delete legacy.delivery_failure;
  const active = observeBrowserTurnFence(legacy, snap({ observed_at_ms: 1200, generation_active: true }));
  assert.equal(active.phase, 'running', 'pre-upgrade checkpoints without a failure field remain compatible');
}

console.log('browser-turn-fence: original acceptance/tool/stale coverage and native failure, clearance latch, fresh recovery, late failure and no-resubmit regressions OK');
