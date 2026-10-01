/* Where the AI Inbox lives on the server.
   The books themselves stay in the owner's browser; the server only keeps
   (1) inbox.json  — lines Claude sent from a claude.ai chat, waiting for approval
   (2) snapshot.json — a recent copy of the registers the app uploads, so Claude can avoid duplicates.
   Render's free disk is wiped on every restart, so with GITHUB_TOKEN + GITHUB_REPO set the two files
   are kept on a separate branch of the repo ("nirman-inbox") — that branch is never deployed. */
const fs=require('fs'), path=require('path');

function fileStore(dir){
  fs.mkdirSync(dir,{recursive:true});
  const p=n=>path.join(dir,n);
  return {
    kind:'file',
    async read(name,def){ try{ return JSON.parse(fs.readFileSync(p(name),'utf8')); }catch(e){ return def; } },
    async write(name,data){ fs.writeFileSync(p(name),JSON.stringify(data)); }
  };
}

function githubStore(token,repo,branch){
  const api='https://api.github.com/repos/'+repo;
  const H={authorization:'Bearer '+token,accept:'application/vnd.github+json','user-agent':'nirman-ledger','x-github-api-version':'2022-11-28'};
  const sha={}; let branchReady=null;
  async function gh(url,opt){ const r=await fetch(url,Object.assign({headers:H},opt||{})); const j=await r.json().catch(()=>({})); return {ok:r.ok,status:r.status,j}; }
  async function ensureBranch(){
    if(branchReady) return branchReady;
    branchReady=(async()=>{
      const b=await gh(api+'/git/ref/heads/'+branch); if(b.ok) return;
      const repoInfo=await gh(api); const def=(repoInfo.j&&repoInfo.j.default_branch)||'main';
      const base=await gh(api+'/git/ref/heads/'+def); if(!base.ok) throw new Error('GitHub: cannot read branch '+def+' ('+base.status+')');
      const c=await gh(api+'/git/refs',{method:'POST',body:JSON.stringify({ref:'refs/heads/'+branch,sha:base.j.object.sha})});
      if(!c.ok&&c.status!==422) throw new Error('GitHub: cannot create branch '+branch+' ('+c.status+')');
    })();
    try{ await branchReady; }catch(e){ branchReady=null; throw e; }
    return branchReady;
  }
  return {
    kind:'github',
    async read(name,def){
      await ensureBranch();
      const r=await gh(api+'/contents/'+name+'?ref='+branch);
      if(r.status===404) return def;
      if(!r.ok) throw new Error('GitHub read '+name+': '+r.status);
      sha[name]=r.j.sha;
      try{ return JSON.parse(Buffer.from(r.j.content,'base64').toString('utf8')); }catch(e){ return def; }
    },
    async write(name,data){
      await ensureBranch();
      const body={message:'Nirman inbox: update '+name,branch,content:Buffer.from(JSON.stringify(data)).toString('base64')};
      if(sha[name]) body.sha=sha[name];
      let r=await gh(api+'/contents/'+name,{method:'PUT',body:JSON.stringify(body)});
      if(r.status===409||r.status===422){ await this.read(name,null); if(sha[name]) body.sha=sha[name]; r=await gh(api+'/contents/'+name,{method:'PUT',body:JSON.stringify(body)}); }
      if(!r.ok) throw new Error('GitHub write '+name+': '+r.status);
      sha[name]=r.j.content&&r.j.content.sha;
    }
  };
}

/* One queue so two requests never overwrite each other */
function makeStore(env){
  const base=env.GITHUB_TOKEN&&env.GITHUB_REPO?githubStore(env.GITHUB_TOKEN,env.GITHUB_REPO,env.INBOX_BRANCH||'nirman-inbox'):fileStore(env.DATA_DIR||path.join(__dirname,'..','data'));
  let q=Promise.resolve(); const run=fn=>{ const p=q.then(fn,fn); q=p.catch(()=>{}); return p; };
  let cache=null;
  const load=async()=>{ if(!cache) cache=await base.read('inbox.json',[]); return cache; };
  const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
  return {
    kind:base.kind,
    addInbox:doc=>run(async()=>{ const list=await load(); const id=uid(); list.push(Object.assign({id},doc)); if(list.length>500) list.splice(0,list.length-500); await base.write('inbox.json',list); return id; }),
    listInbox:async n=>{ const list=await run(load); return list.slice().sort((a,b)=>(b.createdAt||'')<(a.createdAt||'')?-1:1).slice(0,n||100); },
    updateInbox:(id,patch)=>run(async()=>{ const list=await load(); const x=list.find(i=>i.id===id); if(!x) return false;
      ['status','decidedBy','decidedAt','applied','reason'].forEach(k=>{ if(patch[k]!==undefined) x[k]=String(patch[k]).slice(0,1000); }); await base.write('inbox.json',list); return true; }),
    saveSnapshot:snap=>run(()=>base.write('snapshot.json',snap)),
    async listItems(col){ const s=await run(()=>base.read('snapshot.json',null)); return (s&&s.items&&s.items[col])||[]; },
    async snapshotAt(){ const s=await run(()=>base.read('snapshot.json',null)); return s&&s.at||null; }
  };
}
module.exports={makeStore};
