const assert=require('node:assert/strict');
const test=require('node:test');
const {createApp}=require('./support/webview.cjs');
function choose(app){app.click(app.row('README.md').querySelector('[data-filename]'));}
test('unsupported Ctrl and Meta combinations never fall back to primitive function-key actions',t=>{
 for(const key of ['F5','F6','F7','F8']) for(const modifier of ['ctrlKey','metaKey']){
 const app=createApp(t);choose(app);const before=JSON.stringify(app.state().folders);app.key(key,{[modifier]:true});
 assert.equal(app.document.querySelector('#modal').open,false,`${modifier}+${key}`);assert.equal(app.document.querySelector('.inline-rename'),null);assert.equal(JSON.stringify(app.state().folders),before);
 }
});
test('unsupported Alt modifiers and compound modifiers cannot trigger mkdir or delete',t=>{
 for(const [key,modifiers]of[['F7',{altKey:true}],['F8',{altKey:true}],['F8',{altKey:true,shiftKey:true}],['F5',{ctrlKey:true,shiftKey:true}],['F6',{metaKey:true,altKey:true}]]){
 const app=createApp(t);choose(app);app.key(key,modifiers);assert.equal(app.document.querySelector('#modal').open,false,`${key} ${JSON.stringify(modifiers)}`);
 }
});
test('function keys are inert in text fields, ordinary editor surfaces and unrelated controls',t=>{
 for(const targetType of ['input','editor','button']){
 const app=createApp(t);choose(app);let target;
 if(targetType==='input') target=app.document.querySelector('.path-input');else{target=app.document.createElement(targetType==='button'?'button':'div');target.tabIndex=0;if(targetType==='editor')target.contentEditable='true';app.document.body.append(target);}
 target.focus();app.key('F8',{},target);app.key('F5',{ctrlKey:true},target);assert.equal(app.document.querySelector('#modal').open,false,targetType);
 }
});
test('open dialogs retain their values and ignore unrelated primitive shortcuts',t=>{
 const app=createApp(t);choose(app);app.action('copy');const input=app.document.querySelector('#value');input.value='preserved';
 for(const key of ['F5','F6','F7','F8'])app.key(key,{ctrlKey:true},input);
 assert.equal(input.value,'preserved');assert.match(app.document.querySelector('#modal-title').textContent,/Kopieren/);
});
