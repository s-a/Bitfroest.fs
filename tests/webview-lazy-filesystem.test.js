const assert = require('node:assert/strict');
const test = require('node:test');
const {createApp} = require('./support/webview.cjs');
function fixture() {
 const pane=path=>({tabs:[path],tab:0,selected:[],cursor:null,sort:'name',descending:false,filter:''});
 return {version:1,realFilesystem:true,snapshotId:'old',active:0,panes:[pane('C:/tmp'),pane('C:/temp')],unloadedFolders:['C:/tmp/docs','C:/temp/incoming'],folders:{'C:/tmp':[{id:'docs',name:'docs',type:'folder',fsSource:'C:/tmp/docs'},{id:'a',name:'a.txt',type:'text',content:'a',size:1,fsSource:'C:/tmp/a.txt'}],'C:/temp':[{id:'incoming',name:'incoming',type:'folder'}],'C:/tmp/docs':[],'C:/temp/incoming':[]}};
}
function select(app,name){app.click(app.row(name).querySelector('[data-filename]'));}
function result(app, extra={}) {const fresh=app.state();fresh.snapshotId='new';fresh.unloadedFolders=[];fresh.folders['C:/tmp/docs']=[{id:'child',name:'child.txt',type:'text',size:1,fsSource:'C:/tmp/docs/child.txt'}];app.window.dispatchEvent(new app.window.MessageEvent('message',{data:{type:'filesystem-result',ok:true,state:fresh,...extra}}));}
test('opening an unloaded folder waits for its shallow snapshot before changing directory',t=>{
 const app=createApp(t,fixture());select(app,'docs');app.key('Enter');
 const request=app.messages.find(message=>message.type==='filesystem-navigate');assert.ok(request);assert.equal(request.path,'C:/tmp/docs');
 assert.equal(app.state().panes[0].tabs[0],'C:/tmp');assert.equal(app.document.querySelector('#modal').open,false);
 result(app,{resumeNavigation:{path:'C:/tmp/docs',side:0}});
 assert.equal(app.state().panes[0].tabs[0],'C:/tmp/docs');assert.ok(app.row('child.txt'));
});
test('delete and rename prepare their selected subtree before opening a single dialog',t=>{
 for(const action of ['delete','rename']){const app=createApp(t,fixture());select(app,'docs');app.action(action);
 const request=app.messages.find(message=>message.type==='filesystem-prepare');assert.ok(request,action);assert.deepEqual([...request.paths],['C:/tmp/docs']);
 assert.equal(app.document.querySelector('#modal').open,false);assert.equal(app.messages.some(message=>message.type==='filesystem-apply'),false);
 result(app,{resumeAction:action});assert.equal(app.document.querySelector('#modal').open,true,action);
 assert.equal(app.messages.filter(message=>message.type==='filesystem-prepare').length,1);
 }
});
test('inline folder rename waits for recursive preparation and resumes on the same file',t=>{
 const app=createApp(t,fixture());select(app,'docs');app.action('rename-one');assert.equal(app.document.querySelector('.inline-rename'),null);
 assert.equal(app.messages.find(message=>message.type==='filesystem-prepare').action,'rename-one');result(app,{resumeAction:'rename-one'});
 assert.equal(app.document.querySelector('.inline-rename').value,'docs');
});
test('failed preparation does not open the deferred operation dialog',t=>{
 const app=createApp(t,fixture());select(app,'docs');app.action('delete');app.window.dispatchEvent(new app.window.MessageEvent('message',{data:{type:'filesystem-result',ok:false,state:app.state()}}));
 assert.equal(app.document.querySelector('#modal-title').textContent,'Dateioperation fehlgeschlagen');assert.ok(app.document.querySelector('.operation-error-text'));assert.equal(app.messages.some(message=>message.type==='filesystem-apply'),false);assert.equal(app.messages.some(message=>message.type==='filesystem-delete'),false);
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function submit(app){app.document.querySelector('#modal-form').dispatchEvent(new app.window.Event('submit',{bubbles:true,cancelable:true}));}
test('existing target folder children are prepared and collisions wait for explicit decisions',async t=>{
 const state=fixture();state.folders['C:/temp'].push({id:'target-docs',name:'docs',type:'folder'});state.folders['C:/temp/docs']=[];state.unloadedFolders.push('C:/temp/docs');
 const app=createApp(t,state);select(app,'docs');app.action('copy');assert.equal(app.document.querySelector('#modal').open,true);assert.equal(app.messages.some(m=>m.type==='filesystem-prepare'),false);submit(app);const request=app.messages.find(m=>m.type==='filesystem-prepare');assert.deepEqual([...request.paths],['C:/tmp/docs','C:/temp/docs']);
 const fresh=app.state();fresh.unloadedFolders=[];fresh.snapshotId='new';fresh.folders['C:/tmp/docs']=[{id:'source-child',name:'same.txt',type:'text',content:'new',fsSource:'C:/tmp/docs/same.txt'}];fresh.folders['C:/temp/docs']=[{id:'target-child',name:'same.txt',type:'text',content:'old',fsSource:'C:/temp/docs/same.txt'}];
 app.window.dispatchEvent(new app.window.MessageEvent('message',{data:{type:'filesystem-result',ok:true,state:fresh}}));await tick();
 assert.ok(app.document.querySelector('[data-conflict-action="overwrite"]'));assert.equal(app.messages.some(m=>m.type==='filesystem-apply'),false);assert.equal(app.state().folders['C:/temp/docs'][0].content,'old');
});
test('a target edited in the transfer dialog is prepared without losing the chosen filter',async t=>{
 const app=createApp(t,fixture());select(app,'a.txt');app.action('copy');app.document.querySelector('#value').value='C:/temp/incoming';app.document.querySelector('#transfer-filter').value='*.txt';submit(app);await tick();
 const request=app.messages.find(m=>m.type==='filesystem-prepare');assert.ok(request);assert.deepEqual([...request.paths],['C:/temp/incoming']);assert.equal(request.recursive,false);assert.equal(app.messages.some(m=>m.type==='filesystem-apply'),false);
 result(app);await tick();const apply=app.messages.find(m=>m.type==='filesystem-apply');assert.ok(apply);assert.ok(apply.state.folders['C:/temp/incoming'].some(file=>file.name==='a.txt'));assert.equal(app.state().folders['C:/temp/incoming'].some(file=>file.name==='a.txt'),false);
 app.window.dispatchEvent(new app.window.MessageEvent('message',{data:{type:'filesystem-result',operationId:apply.operationId,ok:true,state:apply.state}}));assert.ok(app.state().folders['C:/temp/incoming'].some(file=>file.name==='a.txt'));
});
test('opening a folder in the opposite new tab waits for loading and leaves the source path intact',t=>{
 const app=createApp(t,fixture());select(app,'docs');app.action('open-dir-other-tab');assert.equal(app.state().panes[1].tabs.length,1);result(app);
 assert.equal(app.state().panes[0].tabs[0],'C:/tmp');assert.equal(app.state().panes[1].tabs.at(-1),'C:/tmp/docs');assert.equal(app.state().active,1);
});
test('dropping on an unloaded destination retains the source selection and move mode after loading',async t=>{
 const app=createApp(t,fixture()), store=new Map(),data={setData:(key,value)=>store.set(key,value),getData:key=>store.get(key)||''};select(app,'a.txt');
 const drag=(type,target)=>{const event=new app.window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:data});Object.defineProperty(event,'shiftKey',{value:true});target.dispatchEvent(event);};
 drag('dragstart',app.row('a.txt').querySelector('[data-filename]'));drag('drop',app.document.querySelector('[data-pane="1"] tr[data-id="incoming"]'));
 assert.equal(app.document.querySelector('#modal').open,true);assert.equal(app.messages.some(m=>m.type==='filesystem-prepare'),false);assert.match(app.document.querySelector('#modal-title').textContent,/Verschieben/);assert.equal(app.document.querySelector('#value').value,'C:\\temp\\incoming');assert.equal(app.document.querySelector('[data-transfer-source]').textContent,'C:\\tmp');submit(app);await tick();const request=app.messages.find(m=>m.type==='filesystem-prepare');assert.deepEqual([...request.paths],['C:/temp/incoming']);assert.equal(request.recursive,false);
 result(app);await tick();assert.equal(app.state().panes[0].selected[0],'a');
});

test('a folder rename mask prepares the renamed merge target rather than the original folder name', async t => {
 const state=fixture();state.unloadedFolders=['C:/temp/docs.new'];state.folders['C:/temp'].push({id:'target-docs',name:'docs.new',type:'folder',fsSource:'C:/temp/docs.new'});state.folders['C:/temp/docs.new']=[];
 state.folders['C:/tmp/docs']=[{id:'child',name:'same.txt',type:'text',content:'source',size:6,fsSource:'C:/tmp/docs/same.txt'}];
 const app=createApp(t,state);select(app,'docs');app.action('copy');app.document.querySelector('#value').value='C:/temp/*.new';submit(app);await tick();
 const request=app.messages.find(message=>message.type==='filesystem-prepare');assert.ok(request);assert.deepEqual([...request.paths],['C:/temp/docs.new']);
 assert.equal(app.messages.some(message=>message.type==='filesystem-apply'),false);
 const fresh=app.state();fresh.snapshotId='merge';fresh.unloadedFolders=[];fresh.folders['C:/temp/docs.new']=[{id:'old',name:'same.txt',type:'text',content:'target',size:6,fsSource:'C:/temp/docs.new/same.txt'}];
 app.window.dispatchEvent(new app.window.MessageEvent('message',{data:{type:'filesystem-result',ok:true,state:fresh}}));await tick();
 assert.equal(app.document.querySelector('#modal-title').textContent,'Datei bereits vorhanden');assert.equal(app.messages.some(message=>message.type==='filesystem-apply'),false);
});

test('individual folder names prepare their chosen merge subtree without repeating the name prompt', async t => {
 const state=fixture();state.unloadedFolders=['C:/temp/docs.new'];state.folders['C:/tmp/docs']=[{id:'child',name:'same.txt',type:'text',content:'new',size:3,fsSource:'C:/tmp/docs/same.txt'}];state.folders['C:/temp'].push({id:'target',name:'docs.new',type:'folder',fsSource:'C:/temp/docs.new'});state.folders['C:/temp/docs.new']=[];
 const app=createApp(t,state);select(app,'docs');app.action('copy');app.document.querySelector('#transfer-individual').checked=true;submit(app);await tick();
 app.document.querySelector('#value').value='docs.new';submit(app);await tick();
 const request=app.messages.find(message=>message.type==='filesystem-prepare');assert.ok(request);assert.deepEqual([...request.paths],['C:/temp/docs.new']);
 assert.equal(app.document.querySelector('#value').value,'docs.new');assert.equal(app.messages.some(message=>message.type==='filesystem-apply'),false);
 const fresh=app.state();fresh.snapshotId='indiv';fresh.unloadedFolders=[];fresh.folders['C:/temp/docs.new']=[{id:'old',name:'same.txt',type:'text',content:'old',size:3,fsSource:'C:/temp/docs.new/same.txt'}];
 app.window.dispatchEvent(new app.window.MessageEvent('message',{data:{type:'filesystem-result',ok:true,state:fresh}}));await tick();
 assert.equal(app.document.querySelector('#modal-title').textContent,'Datei bereits vorhanden');assert.equal(app.messages.some(message=>message.type==='filesystem-apply'),false);
});
