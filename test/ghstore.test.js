/* GitHub-branch storage with a fake GitHub API */
const {makeStore}=require('../lib/store');
const files={}, refs={'heads/main':'abc'}; let calls=[];
global.fetch=async(url,opt={})=>{ const m=opt.method||'GET'; calls.push(m+' '+url.replace('https://api.github.com/repos/o/r','')); const u=url.replace('https://api.github.com/repos/o/r','');
  const J=(s,j)=>({ok:s<300,status:s,json:async()=>j});
  if(opt.headers.authorization!=='Bearer TK') return J(401,{});
  if(m==='GET'&&u==='') return J(200,{default_branch:'main'});
  let x=u.match(/^\/git\/ref\/heads\/(.+)$/); if(m==='GET'&&x) return refs['heads/'+x[1]]?J(200,{object:{sha:refs['heads/'+x[1]]}}):J(404,{});
  if(m==='POST'&&u==='/git/refs'){ const b=JSON.parse(opt.body); refs[b.ref.replace('refs/','')]=b.sha; return J(201,{}); }
  x=u.match(/^\/contents\/([^?]+)(\?ref=(.+))?$/);
  if(x&&m==='GET'){ const f=files[x[1]]; return f?J(200,{sha:f.sha,content:Buffer.from(f.c).toString('base64')}):J(404,{}); }
  if(x&&m==='PUT'){ const b=JSON.parse(opt.body); if(b.branch!=='nirman-inbox') return J(400,{}); const f=files[x[1]]; if(f&&b.sha!==f.sha) return J(409,{});
    const sha='s'+Math.random(); files[x[1]]={sha,c:Buffer.from(b.content,'base64').toString()}; return J(200,{content:{sha}}); }
  return J(500,{});
};
(async()=>{
  const st=makeStore({GITHUB_TOKEN:'TK',GITHUB_REPO:'o/r'});
  const id=await st.addInbox({status:'PENDING_REVIEW',createdAt:'2026-10-01T10:00:00Z',entries:'[]'});
  await st.addInbox({status:'PENDING_REVIEW',createdAt:'2026-10-01T11:00:00Z',entries:'[]'});
  await st.updateInbox(id,{status:'APPROVED'});
  const st2=makeStore({GITHUB_TOKEN:'TK',GITHUB_REPO:'o/r'});   // fresh server after a Render restart
  const l=await st2.listInbox(10);
  const ok=refs['heads/nirman-inbox']==='abc'&&l.length===2&&l.find(x=>x.id===id).status==='APPROVED'&&!calls.some(c=>/PUT/.test(c)&&!/contents/.test(c));
  console.log(ok?'PASS github branch store survives a restart':'FAIL '+JSON.stringify({refs,l,calls}));
  process.exit(ok?0:1);
})();
