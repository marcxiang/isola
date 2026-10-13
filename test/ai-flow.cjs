const assert=require('node:assert/strict'),http=require('node:http');
const {saveSettings,requestModel}=require('../src/ai.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=5000){const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw Error('Timed out waiting for AI state');await sleep(20);}}
module.exports=async(api,check)=>{
 let mode='pause',count=0,requests=[],events=[],timers=new Set(),w,p;
 const fixture='<!doctype html><title>Flow fixture</title><style>body{font:18px sans-serif;padding:40px}button{padding:18px;margin:8px}</style><h1>Category selection</h1><button id="choose">Category</button><button id="noop">No change</button><button id="delete">Delete account</button><p id="result">Choose a category</p><script>window.clicks=0;choose.onclick=()=>{clicks++;result.textContent="Category selected"};document.querySelector("#delete").onclick=()=>window.deleted=true;</script>';
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/page'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const data=JSON.parse(raw);requests.push(data);count++;
  const responses=req.url.endsWith('/responses'),history=responses?data.input:data.messages;
  const pages=[];for(const item of history){const text=item.output||(typeof item.content==='string'?item.content:'');try{const s=JSON.parse(text.slice(text.indexOf('{')));if(s.elements)pages.push(s);}catch{}}
  const page=pages.at(-1),action=(name,label)=>({action:name,elementId:page?.elements.find(x=>x.label===label)?.id||null,intent:'选择分类',text:null,url:null,direction:null,amount:null});
  const final=text=>responses?{output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}:{choices:[{message:{role:'assistant',content:text}}]};
  const calls=args=>responses?{output:args.map((a,i)=>({type:'function_call',call_id:'c'+count+'_'+i,name:'browser_action',arguments:JSON.stringify(a)}))}:{choices:[{message:{role:'assistant',content:null,tool_calls:args.map((a,i)=>({id:'c'+count+'_'+i,type:'function',function:{name:'browser_action',arguments:JSON.stringify(a)}}))}}]};
  res.setHeader('Content-Type','application/json');
  if(mode==='retry'&&count===1){res.writeHead(503);res.end('{"error":{"message":"busy"}}');return;}
  if(mode==='pause'&&count===1){const t=setTimeout(()=>{timers.delete(t);if(!res.destroyed)res.end(JSON.stringify(calls([action('click','Category')])));},3000);timers.add(t);return;}
  let out;
  if(mode==='empty')out=final('');
  else if(mode==='batch'&&count===1)out=calls([action('click','Category'),action('click','Delete account')]);
  else if(mode==='early'&&count===1)out=final('已完成');
  else if(mode==='early'&&count===2)out=calls([action('click','Category')]);
  else if(mode==='pause'&&count===2)out=calls([action('click','Updated category')]);
  else if(mode==='noop')out=calls([action('click','No change')]);
  else out=final('页面显示 Category selected。');
  res.end(JSON.stringify(out));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const reset=async(next,protocol='responses',visionEnabled=false)=>{mode=next;count=0;requests=[];events=[];await w.tabs[0].view.webContents.loadURL(origin+'/page');saveSettings({baseURL:origin+'/v1',protocol,model:'flow-qa',apiKey:'',maxSteps:10,visionEnabled});};
 try{
  p=api.saveProfile({name:'QA AI flow',url:origin+'/page',fingerprintMode:'native',width:1100,height:800});await api.launch(p.id);w=api.windows.get(p.id);const c=w.tabs[0].view.webContents;
  const emit=w.aiAgent.emit.bind(w.aiAgent);w.aiAgent.emit=()=>{events.push(JSON.parse(JSON.stringify(w.aiAgent.state)));emit();};
  await check('pause interrupts model wait; resume refreshes IDs after manual changes',async()=>{
   await reset('pause');const task=w.aiAgent.start('选择分类');await until(()=>requests.length===1);const start=Date.now();w.aiAgent.pause();await until(()=>w.aiAgent.state.status==='paused',1500);assert.ok(Date.now()-start<1500);
   assert.equal(await c.executeJavaScript('window.clicks'),0);await c.executeJavaScript('choose.textContent="Updated category"');w.aiAgent.resume();const result=await task;
   assert.equal(result.status,'complete');assert.equal(await c.executeJavaScript('window.clicks'),1);assert.ok(JSON.stringify(requests[1]).includes('Updated category'));
   assert.ok(events.some(e=>e.currentAction?.label==='Updated category'));assert.ok(events.some(e=>e.status==='verifying'));return {pauseMilliseconds:Date.now()-start,refreshedTarget:true};
  });
  await check('stop wakes a paused task and leaves no queued action',async()=>{
   await reset('pause');const task=w.aiAgent.start('选择分类');await until(()=>requests.length===1);w.aiAgent.pause();await until(()=>w.aiAgent.state.status==='paused');w.aiAgent.stop();await task;assert.equal(w.aiAgent.state.status,'stopped');assert.equal(await c.executeJavaScript('window.clicks'),0);
  });
  await check('multiple queued model actions execute only the first and return matched tool outputs',async()=>{
   await reset('batch','chat');const result=await w.aiAgent.start('选择分类');assert.equal(result.status,'complete');assert.equal(await c.executeJavaScript('window.clicks'),1);assert.equal(await c.executeJavaScript('window.deleted'),undefined);
   const outputs=requests[1].messages.filter(x=>x.role==='tool');assert.equal(outputs.length,2);assert.equal(JSON.parse(outputs[1].content).errorCode,'ACTION_NOT_EXECUTED');assert.ok(events.some(e=>e.logs.some(x=>x.kind==='observation')));
  });
  await check('premature completion is checked against a fresh snapshot and can continue',async()=>{
   await reset('early');const result=await w.aiAgent.start('选择分类');assert.equal(result.status,'complete');assert.equal(await c.executeJavaScript('window.clicks'),1);assert.ok(JSON.stringify(requests[1]).includes('Before giving the final answer'));assert.equal(result.progress.step,1);
  });
  await check('empty model response produces a useful error, never a false completion',async()=>{
   await reset('empty');const result=await w.aiAgent.start('选择分类');assert.equal(result.status,'error');assert.match(result.result,/没有返回/);
  });
  await check('unchanged repeated actions stop instead of consuming the whole operation budget',async()=>{
   await reset('noop');const result=await w.aiAgent.start('检查无变化控件');assert.equal(result.status,'blocked');assert.ok(count<=4);assert.match(result.result,/没有可观察/);
  });
  await check('temporary provider busy response retries and request cancellation remains available',async()=>{
   await reset('retry');const result=await requestModel({baseURL:origin+'/v1',model:'flow-qa',protocol:'responses',apiKey:''},[{role:'user',content:'test'}],new AbortController().signal);assert.ok(result.text);assert.equal(count,2);
  });
  for(const protocol of ['responses','chat'])await check('optional masked image is attached using '+protocol+' format',async()=>{
   await reset('vision',protocol,true);const result=await w.aiAgent.start('读取分类页面');assert.equal(result.status,'complete');const history=protocol==='responses'?requests[0].input:requests[0].messages;
   const image=history.flatMap(x=>Array.isArray(x.content)?x.content:[]).find(x=>x.type===(protocol==='responses'?'input_image':'image_url'));assert.ok(image,'image missing: '+JSON.stringify(result.logs));const url=protocol==='responses'?image.image_url:image.image_url.url;assert.match(url,/^data:image\/jpeg;base64,/);
  });
 }finally{
  for(const t of timers)clearTimeout(t);if(w&&!w.isDestroyed()){w.aiAgent.stop();w.close();}await sleep(200);if(p)await api.deleteProfile(p.id);server.closeAllConnections();await new Promise(r=>server.close(r));
 }
};
