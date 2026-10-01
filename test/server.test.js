/* Starts server.js on a free port with a temp data folder and checks the connector + inbox API. */
const {spawn}=require('child_process'), os=require('os'), path=require('path'), fs=require('fs');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport}=require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nl-')), PORT=String(39000+Math.floor(Math.random()*500)), TOK='TestToken123';
const p=spawn(process.execPath,[path.join(__dirname,'..','server.js')],{env:Object.assign({},process.env,{PORT,MCP_TOKEN:TOK,DATA_DIR:dir,GITHUB_TOKEN:''}),stdio:['ignore','pipe','pipe']});
let fail=0; const ok=(c,m)=>{ console.log((c?'PASS ':'FAIL ')+m); if(!c) fail++; };
const base='http://127.0.0.1:'+PORT;
setTimeout(async()=>{
  try{
    ok((await fetch(base+'/')).status===200,'site still serves the app');
    const ping=await (await fetch(base+'/api/inbox/ping')).json(); ok(ping.configured&&ping.storage==='file','ping: '+JSON.stringify(ping));
    ok((await fetch(base+'/mcp/wrong',{method:'POST'})).status===404,'wrong connector token → 404');
    ok((await fetch(base+'/api/inbox')).status===401,'inbox without key → 401');
    const snap=await fetch(base+'/api/snapshot',{method:'POST',headers:{'content-type':'application/json','x-inbox-key':TOK},body:JSON.stringify({items:{'lb.murum':[{date:'2026-09-23',qty:10,party:'Madan Yadav'}]}})});
    ok(snap.ok,'app uploads a snapshot');
    const client=new Client({name:'t',version:'1'}); await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp/'+TOK)));
    const tools=(await client.listTools()).tools.map(t=>t.name); ok(tools.includes('nirman_add_entries')&&tools.includes('nirman_recent'),'connector tools: '+tools.join(','));
    const r=await client.callTool({name:'nirman_recent',arguments:{section:'murum',days:400}}); ok(/1 row/.test(r.content[0].text),'recent from snapshot');
    const a=await client.callTool({name:'nirman_add_entries',arguments:{entries:[{section:'dpr',date:'30/09/2026',party:'Dhruv',m:1,h:1,b:0},{section:'murum',date:'2026-09-30',party:'Madan Yadav',qty:7}],note:'test'}});
    ok(!a.isError&&/Sent 2 line/.test(a.content[0].text),'Claude sends 2 lines');
    await client.close();
    const list=await (await fetch(base+'/api/inbox',{headers:{'x-inbox-key':TOK}})).json();
    ok(list.items.length===1&&list.items[0].status==='PENDING_REVIEW'&&JSON.parse(list.items[0].entries).length===2,'app sees the inbox item');
    const id=list.items[0].id;
    const up=await (await fetch(base+'/api/inbox/'+id,{method:'POST',headers:{'content-type':'application/json','x-inbox-key':TOK},body:JSON.stringify({status:'APPROVED',applied:'dpr 1 · murum 1'})})).json();
    ok(up.ok,'mark approved');
    const l2=await (await fetch(base+'/api/inbox',{headers:{'x-inbox-key':TOK}})).json(); ok(l2.items[0].status==='APPROVED','status saved');
    ok(fs.existsSync(path.join(dir,'inbox.json')),'kept on disk (GitHub branch on Render)');
  }catch(e){ console.error(e); fail++; }
  p.kill(); console.log(fail?fail+' FAILED':'ALL PASS'); process.exit(fail?1:0);
},1500);
