const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./support/webview.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const pane = path => ({ tabs: [path], tab: 0, selected: [], cursor: null, filter: '', sort: 'name', descending: false });
  const file = (id, name, content) => ({ id, name, content, type: 'text', size: content.length, date: '29.10.2026 14:32' });
  return { version: 1, active: 0, panes: [pane('/left'), pane('/right')], folders: { '/left': [file('a', 'same.txt', 'new'), file('b', 'other.txt', 'new-other')], '/right': [file('c', 'same.txt', 'old'), file('d', 'other.txt', 'old-other')] } };
}
function submit(app) { app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true })); }
function choose(app, name, extra = {}) { app.click(app.row(name).querySelector('[data-filename]'), extra); }

test('overwrite all dismisses immediately and local cancellation prevents a bulk host commit', async t => {
  for (const cancel of ['button']) {
  const saved = fixture(); saved.realFilesystem = true; saved.snapshotId = 'bulk-conflict';
  for (let i = 0; i < 300; i++) {
    saved.folders['/left'].push({ id: `source-${i}`, name: `bulk-${i}.txt`, type: 'text', size: 1, fsSource: `/left/bulk-${i}.txt` });
    saved.folders['/right'].push({ id: `target-${i}`, name: `bulk-${i}.txt`, type: 'text', size: 1, fsSource: `/right/bulk-${i}.txt` });
  }
  saved.panes[0].selected = saved.folders['/left'].map(file => file.id);
  saved.panes[0].cursor = 'a';
  const expectedFolders = structuredClone(saved.folders);
  const app = createApp(t, saved);
  app.action('copy'); submit(app); await tick();
  const cancellation = new Promise(resolve => app.window.setTimeout(() => {
    if (cancel === 'escape') app.key('Escape', {}, app.document.body);
    else app.click(app.document.querySelector('#status-cancel'));
    resolve();
  }, 0));
  app.click(app.document.querySelector('[data-conflict-action="overwrite-all"]'));
  assert.equal(app.document.querySelector('#modal').open, false);
  await cancellation;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false, 'no disk operation after cancelling the local plan');
  assert.equal(app.messages.some(message => message.type === 'filesystem-cancel'), false, 'local planning has no host operation to cancel');
  assert.deepEqual(app.state().folders, expectedFolders, 'uncommitted model changes are discarded');
  assert.equal(app.document.querySelector('.transfer-progress'), null);
  }
});

test('copy confirmation offers target, file filter and explicit conflict policy before any mutation', t => {
  const app = createApp(t, fixture());
  choose(app, 'same.txt'); app.action('copy');
  assert.equal(app.document.querySelector('#value').value, '/right');
  assert.ok(app.document.querySelector('#transfer-filter'));
  assert.equal(app.document.querySelector('#transfer-policy').value, 'ask');
  assert.equal(app.state().folders['/right'][0].content, 'old');
});

test('copy conflict waits for a specific choice and offers native-style alternatives', async t => {
  const app = createApp(t, fixture());
  choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  for (const action of ['overwrite', 'overwrite-all', 'skip', 'skip-all', 'rename-source', 'rename-target', 'autorename-source', 'autorename-target', 'overwrite-older', 'larger', 'smaller', 'append', 'cancel']) assert.ok(app.document.querySelector(`[data-conflict-action="${action}"]`), action);
  assert.equal(app.state().folders['/right'][0].content, 'old');
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  assert.equal(app.state().folders['/right'].find(file => file.name === 'same.txt').content, 'new');
  assert.equal(app.document.querySelector('#modal').open, false);
});
test('Escape cannot dismiss a transfer conflict, while the progress X cancels its job', async t => {
  const app = createApp(t, fixture());
  choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  assert.ok(app.document.querySelector('[data-conflict-action="overwrite"]'));
  const cancel = new app.window.Event('cancel', { cancelable: true }); app.document.querySelector('#modal').dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  app.click(app.document.querySelector('#status-cancel'));
  assert.equal(app.document.querySelector('#modal').open, false);
});
test('a conflict hides text cancellation but keeps its X and restores cancel on the next dialog', async t => {
  const app = createApp(t, fixture());
  choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  const cancelText = app.document.querySelector('#modal-cancel'), close = app.document.querySelector('#modal-close');
  assert.equal(cancelText.hidden, true);
  assert.equal(close.hidden, false);
  app.click(close); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  app.action('mkdir');
  assert.equal(app.document.querySelector('#modal').open, true);
  assert.equal(cancelText.hidden, false);
});

test('skip-all leaves moved sources intact while overwrite-all applies to subsequent conflicts', async t => {
  for (const action of ['skip-all', 'overwrite-all']) {
    const app = createApp(t, fixture());
    choose(app, 'same.txt'); choose(app, 'other.txt', { ctrlKey: true }); app.action('move'); submit(app); await tick();
    app.click(app.document.querySelector(`[data-conflict-action="${action}"]`)); await tick();
    assert.equal(app.document.querySelector('#modal').open, false);
    assert.equal(app.state().folders['/left'].length, action === 'skip-all' ? 2 : 0);
  }
});

test('cancelled conflicts preserve source and target and explicit rename creates a separate copy', async t => {
  const app = createApp(t, fixture());
  choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  app.click(app.document.querySelector('#modal-close')); await tick();
  assert.equal(app.state().folders['/right'][0].content, 'old');
  app.action('copy'); submit(app); await tick();
  app.document.querySelector('#conflict-name').value = 'renamed.txt';
  app.click(app.document.querySelector('[data-conflict-action="rename-source"]')); await tick();
  assert.equal(app.state().folders['/right'].find(file => file.name === 'renamed.txt').content, 'new');
  assert.equal(app.state().folders['/right'].find(file => file.name === 'same.txt').content, 'old');
});

test('Shift+F5 copies under a new name within the focused directory', async t => {
  const app = createApp(t, fixture());
  choose(app, 'same.txt'); app.key('F5', { shiftKey: true });
  assert.equal(app.document.querySelector('#value').value, '/left/same.txt');
  app.document.querySelector('#value').value = '/left/duplicate.txt'; submit(app); await tick();
  assert.ok(app.state().folders['/left'].some(file => file.name === 'duplicate.txt'));
  assert.equal(app.state().folders['/right'].length, 2);
});

test('real transfers preserve source metadata before host mutation', async t => {
  const state = fixture(); state.realFilesystem = true;
  state.folders['/left'][0].fsSource = '/left/same.txt';
  state.folders['/right'][0].fsSource = '/right/same.txt';
  const app = createApp(t, state);
  choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  assert.equal(app.document.querySelector('[data-conflict-action="append"]').disabled, false);
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  const mutation = app.messages.find(message => message.type === 'filesystem-apply');
  assert.ok(mutation);
  assert.equal(mutation.state.folders['/right'].find(file => file.name === 'same.txt').fsSource, '/left/same.txt');
});

test('favorites navigate while a background copy is waiting in its JavaScript planning phase', async t => {
  const state = fixture(); state.realFilesystem = true;
  let release;
  const app = createApp(t, state, { beforeApp({ window }) {
    const api = window.CommanderTransfer;
    window.CommanderTransfer = { ...api, execute: () => new Promise(resolve => { release = () => resolve({ completed: 0, directories: 0, skipped: 0, cancelled: true, errors: [], completedIds: [] }); }) };
  } });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'favorite-settings', settings: { entries: { elsewhere: '/elsewhere' }, order: ['elsewhere'] } } }));
  choose(app, 'same.txt'); app.action('copy'); app.document.querySelector('#value').value = '/right/new/deep/'; submit(app); await tick();
  const request = app.messages.find(message => message.type === 'filesystem-apply');
  assert.equal(request, undefined);
  const button = app.document.querySelector('[data-favorites]'); app.click(button);
  assert.ok(app.document.querySelector('[data-favorite-menu]'));
  app.click(app.document.querySelector('[data-favorite-entry]'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-navigate' && message.path === '/elsewhere'), false);
  assert.match(app.document.querySelector('#status-message').textContent, /Verzeichnisanfrage wartet auf Kopierplanung/);
  app.click(app.document.querySelector('#status-cancel'));
  release(); await tick();
  assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 0);
  assert.ok(app.messages.some(message => message.type === 'filesystem-navigate' && message.path === '/elsewhere'));
});
test('a successful favorites navigation during the real copy planner preserves its pending commit', async t => {
  const state = fixture(); state.realFilesystem = true; state.snapshotId = 'navigation-copy-race'; state.folders['/right'] = []; state.folders['/elsewhere'] = [];
  let release, executionCount = 0;
  const app = createApp(t, state, { beforeApp({ window }) {
    const api = window.CommanderTransfer;
    window.CommanderTransfer = { ...api, execute: options => new Promise((resolve, reject) => { release = () => { executionCount++; api.execute(options).then(resolve, reject); }; }) };
  } });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'favorite-settings', settings: { entries: { elsewhere: '/elsewhere' }, order: ['elsewhere'] } } }));
  const originalTargetTabId = app.state().panes[0].tabStates?.[app.state().panes[0].tab]?.id;
  choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  assert.equal(typeof release, 'function');
  app.click(app.document.querySelector('[data-favorites]')); app.click(app.document.querySelector('[data-favorite-entry]'));
  assert.equal(app.messages.filter(message => message.type === 'filesystem-navigate' && message.path === '/elsewhere').length, 0, 'host read waits until the real planner and commit dispatch finish');
  assert.equal(app.document.querySelector('[data-pane="0"] .path-input').value, '/elsewhere');
  release(); await tick(); await tick();
  const applies = app.messages.filter(message => message.type === 'filesystem-apply');
  assert.equal(applies.length, 1, 'the planned copy is dispatched once after navigation succeeds');
  assert.ok(applies[0].state.folders['/right'].some(row => row.name === 'same.txt'));
  assert.equal(applies[0].state.panes[0].tabs[0], '/elsewhere');
  assert.equal(applies[0].state.panes[0].tabStates[applies[0].state.panes[0].tab].id, originalTargetTabId);
  assert.equal(executionCount, 1);
  const navigation = app.messages.filter(message => message.type === 'filesystem-navigate' && message.path === '/elsewhere').at(-1);
  assert.ok(navigation);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: applies[0].operationId, ok: true, state: applies[0].state } }));
  const fresh = structuredClone(app.state()); fresh.snapshotId = 'navigation-copy-race-result';
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', navigationRequestId: navigation.navigationRequestId, ok: true, state: fresh } }));
  assert.equal(app.document.querySelector('[data-pane="0"] .path-input').value, '/elsewhere');
  assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1, 'navigation completion cannot dispatch the copy again');
});
test('X cancellation before the host commit discards planner changes and releases deferred navigation', async t => {
  const state = fixture(); state.realFilesystem = true; state.snapshotId = 'cancel-copy-navigation-race'; state.folders['/right'] = []; state.folders['/elsewhere'] = [];
  let release;
  const app = createApp(t, state, { beforeApp({ window }) {
    const api = window.CommanderTransfer;
    window.CommanderTransfer = { ...api, execute: options => new Promise((resolve, reject) => { release = () => api.execute(options).then(resolve, reject); }) };
  } });
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'favorite-settings', settings: { entries: { elsewhere: '/elsewhere' }, order: ['elsewhere'] } } }));
  choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  app.click(app.document.querySelector('[data-favorites]')); app.click(app.document.querySelector('[data-favorite-entry]'));
  assert.equal(app.messages.some(message => message.type === 'filesystem-navigate' && message.path === '/elsewhere'), false);
  app.click(app.document.querySelector('#status-cancel')); release(); await tick(); await tick();
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false, 'unconfirmed planner data never reaches the host');
  const navigation = app.messages.find(message => message.type === 'filesystem-navigate' && message.path === '/elsewhere');
  assert.ok(navigation, 'the deferred navigation is released after cancellation');
  assert.equal(app.messages.some(message => message.type === 'filesystem-cancel'), false, 'pre-commit cancellation has no native operation to cancel');
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', navigationRequestId: navigation.navigationRequestId, ok: true, state: structuredClone(app.state()) } }));
  assert.equal(app.document.querySelector('[data-pane="0"] .path-input').value, '/elsewhere');
  assert.equal(app.messages.some(message => message.type === 'filesystem-apply'), false);
});
test('a queued ZIP starts after an X-cancelled copy planner has finished its outer lifecycle', async t => {
  const state = fixture(); state.realFilesystem = true; state.snapshotId = 'queued-after-planner-cancel'; state.folders['/right'] = [];
  let release;
  const app = createApp(t, state, { beforeApp({ window }) {
    const api = window.CommanderTransfer;
    window.CommanderTransfer = { ...api, execute: options => new Promise((resolve, reject) => { release = () => api.execute(options).then(resolve, reject); }) };
  } });
  app.action('select-all'); app.action('pack'); submit(app);
  const firstZip = app.messages.find(message => message.type === 'zip-write'); assert.ok(firstZip);
  choose(app, 'same.txt'); app.action('copy'); submit(app);
  app.action('select-all'); app.action('pack'); submit(app);
  app.window.dispatchEvent(new app.window.MessageEvent('message', { data: { type: 'filesystem-result', operationId: firstZip.operationId, ok: true, state: app.state() } })); await tick();
  assert.equal(typeof release, 'function');
  assert.equal(app.messages.filter(message => message.type === 'zip-write').length, 1);
  app.click(app.document.querySelector('#status-cancel'));
  assert.equal(app.messages.filter(message => message.type === 'zip-write').length, 1, 'the next job waits for the current planner to unwind');
  release(); await tick(); await tick();
  assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 0);
  assert.equal(app.messages.filter(message => message.type === 'zip-write').length, 2, 'the queued job starts after the planner lifecycle finishes');
});

test('conflict cancellation uses its X while the text button stays hidden',async t=>{
 const app=createApp(t,fixture());choose(app,'same.txt');app.action('copy');submit(app);await tick();
 assert.equal(app.document.querySelector('#modal-cancel').hidden,true);assert.equal(app.document.querySelector('#modal-close').hidden,false);
 app.click(app.document.querySelector('#modal-close'));await tick();assert.equal(app.document.querySelector('#modal').open,false);assert.equal(app.state().folders['/right'][0].content,'old');assert.equal(app.document.querySelector('#modal-cancel').hasAttribute('data-conflict-action'),false);
});

test('reference overwrite alternatives are offered in both languages without duplicate cancellation',async t=>{
 for(const [language,equalLabel,renameLabel]of[['de','Alle älteren und gleich alten überschreiben','Ältere Ziele umbenennen, neuere überspringen'],['en','Overwrite all older and equal','Rename older targets, skip newer']]){
 const app=createApp(t,fixture(),{language});choose(app,'same.txt');app.action('copy');
 assert.equal(app.document.querySelector('#transfer-policy option[value="overwrite-older-equal"]').textContent,equalLabel);
 assert.equal(app.document.querySelector('#transfer-policy option[value="rename-older-target"]').textContent,renameLabel);
 submit(app);await tick();assert.equal(app.document.querySelector('[data-conflict-action="overwrite-older-equal"]').textContent,equalLabel);assert.equal(app.document.querySelector('[data-conflict-action="rename-older-target"]').textContent,renameLabel);
 assert.equal(app.document.querySelectorAll('[data-conflict-action="cancel"]').length,1);
 assert.equal(app.document.querySelector('#conflict-name').value,'same (2).txt');
 }
});

test('copy confirmation creates a missing target directory and supports a destination rename mask',async t=>{
 for(const target of ['/right/new/deep/','/right/new/*.neu']){const app=createApp(t,fixture());choose(app,'same.txt');app.action('copy');app.document.querySelector('#value').value=target;submit(app);await tick();const directory=target.endsWith('/')?'/right/new/deep':'/right/new';const name=target.endsWith('/')?'same.txt':'same.neu';assert.equal(app.state().folders[directory][0].name,name);assert.equal(app.document.querySelector('#modal').open,false);}
});

test('successful copies are unmarked while filtered and skipped entries remain selected',async t=>{
 const state=fixture();state.folders['/left'].push({id:'excluded',name:'excluded.bin',type:'file',size:1});const app=createApp(t,state);
 choose(app,'same.txt');choose(app,'other.txt',{ctrlKey:true});choose(app,'excluded.bin',{ctrlKey:true});app.action('copy');app.document.querySelector('#transfer-filter').value='*.txt';submit(app);await tick();
 app.click(app.document.querySelector('[data-conflict-action="skip"]'));await tick();app.click(app.document.querySelector('[data-conflict-action="overwrite"]'));await tick();assert.deepEqual(app.state().panes[0].selected,['a','excluded']);
});
test('complete unmarking retains the cursor fallback and cancellation keeps only unfinished entries selected',async t=>{
 const state=fixture();state.folders['/right']=[];const app=createApp(t,state);choose(app,'same.txt');app.action('copy');submit(app);await tick();assert.deepEqual(app.state().panes[0].selected,[]);assert.equal(app.state().panes[0].cursor,'a');app.action('edit');assert.ok(app.messages.find(message=>message.type==='edit'));
 const partial=fixture();partial.folders['/left'].unshift({id:'done',name:'done.txt',type:'text',content:'done',size:4});const other=createApp(t,partial);choose(other,'done.txt');choose(other,'same.txt',{ctrlKey:true});choose(other,'other.txt',{ctrlKey:true});other.action('copy');submit(other);await tick();other.click(other.document.querySelector('#modal-close'));await tick();assert.deepEqual(other.state().panes[0].selected,['a','b']);
});

test('conflict F3 shortcuts use frozen real source and target URIs while preserving the dialog',async t=>{
 const state=fixture();state.realFilesystem=true;state.folders['/left'][0].fsSource='/left/same.txt';state.folders['/right'][0].fsSource='/right/same.txt';delete state.folders['/left'][0].content;delete state.folders['/right'][0].content;
 const app=createApp(t,state);choose(app,'same.txt');app.action('copy');submit(app);await tick();const input=app.document.querySelector('#conflict-name');input.value='keep-me.txt';
 app.key('F3',{},input);app.key('F3',{shiftKey:true},input);app.key('F3',{ctrlKey:true},input);
 const views=app.messages.filter(message=>message.type==='conflict-preview');assert.deepEqual(views.map(message=>message.path),['/right/same.txt','/left/same.txt']);const compare=app.messages.find(message=>message.type==='compare');assert.equal(compare.sourcePath,'/left/same.txt');assert.equal(compare.targetPath,'/right/same.txt');assert.equal(input.value,'keep-me.txt');assert.equal(app.document.querySelector('#modal').open,true);assert.equal(app.document.querySelector('#conflict-compare').disabled,false);assert.equal(app.messages.some(message=>message.type==='filesystem-apply'),false);
  app.action('conflict-compare');assert.equal(app.messages.filter(message=>message.type==='compare').length,2);app.click(app.document.querySelector('#modal-close'));await tick();assert.equal(app.messages.filter(message=>message.type==='inputFocus').at(-1).conflict,false);
});

test('real copy reports progress in the statusbar until the host confirms success and exposes host failure without false success',async t=>{
 for(const ok of [true,false]){const state=fixture();state.realFilesystem=true;state.folders['/right']=[];state.folders['/left'][0].fsSource='/left/same.txt';const app=createApp(t,state);choose(app,'same.txt');app.action('copy');submit(app);await tick();
 assert.match(app.document.querySelector('#status-message').textContent,/läuft/);assert.equal(app.document.querySelector('#toast').classList.contains('visible'),false);assert.equal(app.document.querySelector('#panes').inert,false);assert.equal(app.document.querySelector('#functionbar').inert,true);
 const pending=app.messages.find(message=>message.type==='filesystem-apply');assert.ok(pending);const confirmed=ok?JSON.parse(JSON.stringify(pending.state)):state;
 app.window.dispatchEvent(new app.window.MessageEvent('message',{data:{type:'filesystem-result',ok,state:confirmed,error:ok?undefined:'Zugriff verweigert'}}));
 if(ok) assert.match(app.document.querySelector('#status-message').textContent,/1 Datei kopiert/); else assert.match(app.document.querySelector('.operation-error-text').value,/Zugriff verweigert/);assert.equal(app.document.querySelector('#panes').inert,false);
 }
});

test('invalid and colliding conflict rename choices preserve the dialog and allow correction',async t=>{
 for(const action of ['rename-source','rename-target']){const app=createApp(t,fixture());choose(app,'same.txt');app.action('copy');submit(app);await tick();const input=app.document.querySelector('#conflict-name');
 for(const invalid of ['bad?name.txt','other.txt','bad'+String.fromCharCode(0)+'name']){input.value=invalid;app.click(app.document.querySelector(`[data-conflict-action="${action}"]`));await tick();assert.equal(app.document.querySelector('#modal').open,true);assert.equal(input.value,invalid);assert.equal(app.document.activeElement,input);assert.equal(app.state().folders['/right'][0].content,'old');}
 input.value='corrected.txt';app.click(app.document.querySelector(`[data-conflict-action="${action}"]`));await tick();assert.equal(app.document.querySelector('#modal').open,false);assert.ok(app.state().folders['/right'].some(file=>file.name==='corrected.txt'));
 }
});
test('Windows reserved rename destinations stay in the conflict dialog for correction',async t=>{
 const state=fixture();state.panes[0].tabs=['C:/tmp'];state.panes[1].tabs=['C:/temp'];state.folders={'C:/tmp':state.folders['/left'],'C:/temp':state.folders['/right']};const app=createApp(t,state);choose(app,'same.txt');app.action('copy');submit(app);await tick();const input=app.document.querySelector('#conflict-name');input.value='CON.txt';app.click(app.document.querySelector('[data-conflict-action="rename-source"]'));await tick();assert.equal(app.document.querySelector('#modal').open,true);assert.equal(input.value,'CON.txt');assert.equal(app.document.activeElement,input);
});

test('Shift-F5 includes all marked sources and asks for each new name before copying', async t => {
  const app = createApp(t, fixture());
  choose(app, 'same.txt'); choose(app, 'other.txt', { ctrlKey: true }); app.action('copy-same');
  const checkbox = app.document.querySelector('#transfer-individual');
  assert.ok(checkbox); checkbox.checked = true; submit(app); await tick();
  assert.equal(app.document.querySelector('#value').value, 'same.txt');
  app.document.querySelector('#value').value = 'first.txt'; submit(app); await tick();
  assert.equal(app.document.querySelector('#value').value, 'other.txt');
  app.click(app.document.querySelector('#modal-cancel')); await tick();
  assert.ok(app.state().folders['/left'].some(row => row.name === 'first.txt'));
  assert.ok(!app.state().folders['/left'].some(row => row.name === 'other (2).txt'));
  assert.deepEqual(app.state().panes[0].selected, ['b']);
});

test('individual rename phases ignore delayed prior close and retain invalid typed names', async t => {
  const app = createApp(t, fixture());
  app.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open'); queueMicrotask(() => this.dispatchEvent(new app.window.Event('close')));
  };
  choose(app, 'same.txt'); choose(app, 'other.txt', { ctrlKey: true }); app.action('copy-same');
  app.document.querySelector('#transfer-individual').checked = true; submit(app); await tick();
  assert.equal(app.document.querySelector('#modal').open, true);
  const input = app.document.querySelector('#value'); input.value = 'bad?name'; submit(app); await tick();
  assert.equal(app.document.activeElement, input); assert.equal(input.value, 'bad?name');
  assert.equal(app.state().folders['/left'].length, 2);
  input.value = 'first.txt'; submit(app); await tick();
  assert.equal(app.document.querySelector('#value').value, 'other.txt');
  assert.equal(app.document.querySelector('#modal').open, true);
  app.click(app.document.querySelector('#transfer-skip')); await tick();
  assert.equal(app.document.querySelector('#modal').open, false);
  assert.deepEqual(app.state().panes[0].selected, ['b']);
});

test('real append is explicitly offered and sends trusted source references rather than text previews', async t => {
  const state = fixture(); state.realFilesystem = true; state.snapshotId = 'snap';
  for (const [directory, files] of Object.entries(state.folders)) for (const file of files) file.fsSource = `${directory}/${file.name}`;
  const app = createApp(t, state); choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  const append = app.document.querySelector('[data-conflict-action="append"]'); assert.equal(append.disabled, false);
  app.click(append); await tick();
  const mutation = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(mutation);
  const target = mutation.state.folders['/right'][0];
  assert.deepEqual(JSON.parse(JSON.stringify(target.fsAppend)), { source: '/left/same.txt', target: '/right/same.txt' });
  assert.equal(target.content, undefined);
});

test('real transfer progress cancels by job identity and keeps unfinished sources selected', async t => {
  const state = fixture(); state.realFilesystem = true; state.folders['/right'] = [];
  for (const file of state.folders['/left']) file.fsSource = `/left/${file.name}`;
  const before = structuredClone(state), app = createApp(t, state);
  choose(app, 'same.txt'); choose(app, 'other.txt', { ctrlKey: true }); app.action('move'); submit(app); await tick();
  const request = app.messages.find(message => message.type === 'filesystem-apply');
  assert.ok(request.operationId); assert.deepEqual(Array.from(request.transfer.ids), ['a', 'b']);
  const send = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
  send({ type: 'filesystem-progress', operationId: request.operationId, progress: { completedBytes: 3, totalBytes: 12, filesCompleted: 0, filesTotal: 2 } });
  const cancel = app.document.querySelector('[data-cancel-transfer]'); assert.ok(cancel); app.click(cancel);
  assert.equal(app.messages.at(-1).type, 'filesystem-cancel'); assert.equal(app.messages.at(-1).operationId, request.operationId);
  before.folders['/left'] = before.folders['/left'].filter(file => file.id !== 'a');
  send({ type: 'filesystem-result', operationId: request.operationId, ok: true, state: before, operationOutcome: { cancelled: true, completedIds: ['a'] } });
  assert.deepEqual(Array.from(app.state().panes[0].selected), ['b']);
  assert.equal(app.document.querySelector('[data-cancel-transfer]'), null);
  send({ type: 'filesystem-progress', operationId: request.operationId, progress: { completedBytes: 12, totalBytes: 12 } });
  assert.equal(app.document.querySelector('[data-cancel-transfer]'), null);
});

test('pending native transfers retain confirmed rows, sizes and source selection on either pane until actual acknowledgement', async t => {
  for (const side of [0, 1]) for (const mode of ['copy', 'move']) for (const outcome of ['success', 'cancel', 'error']) {
    const state = fixture(); state.realFilesystem = true;
    const sourcePath = side ? '/right' : '/left', targetPath = side ? '/left' : '/right';
    state.active = side; state.folders[targetPath] = [];
    for (const row of state.folders[sourcePath]) row.fsSource = `${sourcePath}/${row.name}`;
    const original = structuredClone(state), app = createApp(t, state);
    const names = section => [...section.querySelectorAll('tbody tr[data-id] [data-filename]')].map(row => row.closest('td').title);
    const section = index => app.document.querySelector(`[data-pane="${index}"]`);
    choose(app, 'same.txt'); choose(app, 'other.txt', { ctrlKey: true }); app.action(mode); submit(app); await tick();
    const request = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(request);
    const send = data => app.window.dispatchEvent(new app.window.MessageEvent('message', { data }));
    send({ type: 'filesystem-progress', operationId: request.operationId, progress: { completedBytes: 1, totalBytes: 12 } });
    assert.deepEqual(names(section(side)), ['other.txt', 'same.txt']); assert.deepEqual(names(section(1 - side)), []);
    assert.equal(section(side).querySelectorAll('tr.selected').length, 2);
    assert.equal(section(1 - side).querySelector('.pane-status').textContent.includes('0 B'), true);
    assert.equal(app.document.querySelector('#panes').inert, false); assert.equal(app.document.querySelector('#functionbar').inert, true);
    app.document.body.classList.toggle('vscode-high-contrast'); await tick();
    assert.deepEqual(names(section(1 - side)), []); assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
    const actual = outcome === 'success' ? structuredClone(request.state) : structuredClone(original);
    if (outcome === 'cancel') {
      actual.folders[targetPath].push({ ...original.folders[sourcePath][0], fsSource: `${targetPath}/same.txt` });
      if (mode === 'move') actual.folders[sourcePath] = actual.folders[sourcePath].filter(row => row.id !== original.folders[sourcePath][0].id);
    }
    send({ type: 'filesystem-result', operationId: request.operationId, ok: outcome !== 'error', state: actual, ...(outcome === 'cancel' ? { operationOutcome: { cancelled: true, completedIds: [original.folders[sourcePath][0].id] } } : {}), ...(outcome === 'error' ? { error: 'denied' } : {}) });
    assert.equal(app.document.querySelector('#panes').inert, false);
    assert.deepEqual(names(section(1 - side)), outcome === 'success' ? ['other.txt', 'same.txt'] : outcome === 'cancel' ? ['same.txt'] : []);
    assert.deepEqual(names(section(side)), outcome === 'success' && mode === 'move' ? [] : outcome === 'cancel' && mode === 'move' ? ['other.txt'] : ['other.txt', 'same.txt']);
    assert.equal(app.messages.filter(message => message.type === 'filesystem-apply').length, 1);
  }
});

test('pending native overwrite retains the confirmed target size and filename', async t => {
  const state = fixture(); state.realFilesystem = true;
  state.folders['/left'][0].fsSource = '/left/same.txt'; state.folders['/right'][0].fsSource = '/right/same.txt';
  state.folders['/right'][0].size = 900;
  const app = createApp(t, state); choose(app, 'same.txt'); app.action('copy'); submit(app); await tick();
  app.click(app.document.querySelector('[data-conflict-action="overwrite"]')); await tick();
  const request = app.messages.find(message => message.type === 'filesystem-apply'); assert.ok(request);
  const target = app.document.querySelector('[data-pane="1"] tr[data-id="c"]'); assert.ok(target);
  assert.equal(target.querySelector('[data-cell="size"]').textContent, '900 B');
  assert.equal(app.state().folders['/right'][0].content, 'old');
  assert.equal(request.state.folders['/right'].find(row => row.name === 'same.txt').size, 3);
});
