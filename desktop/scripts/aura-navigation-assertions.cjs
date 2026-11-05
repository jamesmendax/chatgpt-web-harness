"use strict";
const assert = require("node:assert/strict");

// These checks drive the real scroll container and native wheel path. Outer
// element bounds alone cannot catch a transformed pseudo-element being cut off.
async function assertAuraNavigation({ js, click, wheel, pause }) {
  const samples = [];
  const read = () => js(`(() => {
    const form = document.querySelector('#setup-form'), frame = form.getBoundingClientRect();
    const chapters = [...form.querySelectorAll('.chapter')];
    const active = document.querySelector('#st-index [aria-current="true"]');
    const selected = chapters.find(chapter => chapter.dataset.ch === active?.dataset.ch);
    const positions = chapters.map(chapter => ({id:chapter.dataset.ch,top:chapter.getBoundingClientRect().top,bottom:chapter.getBoundingClientRect().bottom}));
    const atLine = offset => positions.filter(chapter => chapter.top <= frame.top + offset).at(-1) || positions[0];
    return { top:form.scrollTop, max:form.scrollHeight-form.clientHeight, current:active?.dataset.ch,
      expected:atLine(5).id, allowed:[atLine(2).id,atLine(8).id],
      ordinal:chapters.indexOf(selected), visible:!!selected && selected.getBoundingClientRect().bottom > frame.top && selected.getBoundingClientRect().top < frame.bottom,
      x:Math.round(frame.left+frame.width*.6),y:Math.round(frame.top+Math.min(180,frame.height*.4)) };
  })()`);
  const synced = (sample,message) => assert.ok(sample.allowed.includes(sample.current),`${message}: ${JSON.stringify(sample)}`);
  // Native input is queued asynchronously; do not enqueue another wheel before
  // the previous event reached the renderer and its resulting scroll settled.
  // Poll from the Node side so occlusion/throttled requestAnimationFrame cannot
  // turn this into an unbounded wait.
  const waitStable = async (label, before, direction) => {
    const deadline = Date.now() + 6000;
    let last, stableSince = 0, stableSamples = 0;
    let moved = before === undefined;
    while (Date.now() < deadline) {
      const sample = await read();
      if (before !== undefined && Math.abs(sample.top - before) > 1) moved = true;
      const boundary = direction > 0 ? before >= sample.max - 1 : direction < 0 ? before <= 1 : false;
      const same = last && Math.abs(sample.top - last.top) <= 0.5 && sample.current === last.current;
      if (same) stableSamples += 1;
      else { stableSince = Date.now(); stableSamples = 0; }
      if ((moved || boundary) && same && stableSamples >= 3 && Date.now() - stableSince >= 100 && sample.allowed.includes(sample.current)) return sample;
      last = sample;
      await pause(35);
    }
    throw new Error(`settings scroll did not settle (${label}): ${JSON.stringify({before,direction,last})}`);
  };
  const nativeWheel = async (x, y, delta) => {
    await js(`(() => {
      window.__auraWheelProbe = null;
      document.querySelector('#setup-form').addEventListener('wheel', event => {
        window.__auraWheelProbe = {top:event.currentTarget.scrollTop,deltaY:event.deltaY,deltaMode:event.deltaMode,trusted:event.isTrusted};
      }, {once:true,passive:true,capture:true});
    })()`);
    await wheel(x, y, delta);
    const deadline = Date.now() + 6000;
    let event;
    while (Date.now() < deadline && !event) {
      event = await js(`window.__auraWheelProbe`);
      if (!event) await pause(35);
    }
    await js(`delete window.__auraWheelProbe`);
    assert.ok(event?.trusted, `native wheel did not reach settings form: ${JSON.stringify({delta,event})}`);
    assert.equal(Math.sign(event.deltaY), Math.sign(delta), `native wheel direction changed: ${JSON.stringify({delta,event})}`);
    assert.equal(event.deltaMode, 0, `native wheel did not report pixel deltas: ${JSON.stringify(event)}`);
    assert.equal(Math.abs(event.deltaY), Math.abs(delta), `native wheel delta was coalesced or scaled: ${JSON.stringify({delta,event})}`);
    return event;
  };
  await click('#nav [data-view="settings"]');
  await pause(300);
  await click('#st-index [data-ch="tools"]');
  await pause(850);
  const paint = await js(`(() => {
    const nav = document.querySelector('#st-index'), button = nav.querySelector('[aria-current="true"]');
    const b = button.getBoundingClientRect(), n = nav.getBoundingClientRect(), s = getComputedStyle(button), p = getComputedStyle(button,'::before');
    const matrix = new DOMMatrixReadOnly(p.transform === 'none' ? undefined : p.transform);
    const width = parseFloat(p.width), origin = parseFloat(p.transformOrigin), start = b.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft) + parseFloat(p.marginLeft);
    return {left:start+origin-origin*matrix.a+matrix.e,right:start+origin+(width-origin)*matrix.a+matrix.e,clipLeft:n.left+nav.clientLeft,clipRight:n.left+nav.clientLeft+nav.clientWidth};
  })()`);
  assert.ok(paint.left >= paint.clipLeft && paint.right <= paint.clipRight, `selected settings marker is painted outside its scroll clip: ${JSON.stringify(paint)}`);

  const clicked = [];
  const chapters = await js(`[...document.querySelectorAll('#st-index button')].map(button=>button.dataset.ch)`);
  for (const chapter of chapters) {
    await click(`#st-index [data-ch="${chapter}"]`);
    await pause(850);
    const sample = await read(); clicked.push(sample);
    assert.equal(sample.current,chapter,`clicking settings ${chapter} settles on another category`);
    assert.equal(sample.visible,true,`clicked settings ${chapter} is not visible`);
  }

  await waitStable("final chapter navigation");
  await js(`document.querySelector('#setup-form').scrollTo({top:0,behavior:'instant'})`);
  let previous = await waitStable("initial reset");
  assert.ok(previous.top <= 1, "initial settings reset did not reach the top");
  for (const direction of [1, -1]) {
    for (let i = 0; i < 50; i++) {
      const wheelEvent = await nativeWheel(previous.x, previous.y, direction * 80);
      const sample = await waitStable("wheel", previous.top, direction);
      samples.push({direction,wheelEvent,...sample});
      synced(sample,"settings wheel selection does not match the chapter at the reading line");
      assert.equal(sample.visible, true, "selected settings chapter must be visible");
      if (Math.abs(sample.top-previous.top) > 1) {
        assert.ok(direction*(sample.ordinal-previous.ordinal) >= 0, "settings selection reverses while the wheel continues in one direction");
        assert.ok(Math.abs(sample.ordinal-previous.ordinal) <= 1, `small wheel steps skip settings chapters: ${JSON.stringify({previous,sample})}`);
      }
      previous = sample;
      if (direction > 0 ? sample.top >= sample.max-1 : sample.top <= 1) break;
    }
  }
  assert.ok(samples.some(sample=>sample.top>=sample.max-1 && sample.current==='guide'), "final settings chapter is reachable");

  // The same place must select the same category after either travel direction.
  const byPosition = [];
  for (const top of [480,640,480,320,480]) {
    await js(`document.querySelector('#setup-form').scrollTo({top:${top},behavior:'instant'})`);
    await pause(60);
    const sample = await read();byPosition.push(sample);
    synced(sample,"history-dependent settings selection");
  }
  assert.equal(new Set(byPosition.filter(sample=>Math.abs(sample.top-480)<1).map(sample=>sample.current)).size,1,"same scroll position has different settings selections");

  // A wheel reversal during click navigation must take effect without waiting
  // for a timer or allowing the old smooth animation to pull the page back.
  await js(`document.querySelector('#setup-form').scrollTo({top:0,behavior:'instant'})`);
  await pause(60);
  await click('#st-index [data-ch="guide"]');
  await pause(100);
  const moving = await read();
  const wheelEvent = await nativeWheel(moving.x,moving.y,-80);
  const interrupted = await waitStable("reversed wheel", wheelEvent.top, -1);
  assert.ok(wheelEvent?.trusted && wheelEvent.deltaY < 0,"native reversed wheel did not reach the settings form");
  synced(interrupted,"wheel reversal leaves click navigation selection stale");
  assert.ok(interrupted.top < wheelEvent.top,`wheel reversal did not interrupt click navigation: ${JSON.stringify({moving,wheelEvent,interrupted})}`);
  await pause(700);
  const settled = await read();
  assert.ok(settled.top <= interrupted.top+1,"cancelled settings animation resumed after wheel input");
  synced(settled,"settled settings selection differs from visible content");
  return {paint,clicked,samples,byPosition,moving,wheelEvent,interrupted,settled};
}
module.exports = { assertAuraNavigation };
