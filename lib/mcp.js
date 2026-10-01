/* MCP server for the Claude custom connector "Nirman Ledger".
   `store` hides the database so the same code runs on Firebase and in tests:
     store.addInbox(doc) -> id · store.listItems(col) -> [record] · store.listInbox(n) -> [doc]          */
const {McpServer}=require('@modelcontextprotocol/sdk/server/mcp.js');
const {z}=require('zod');
const {SECTIONS,GUIDE,normalizeEntries,isoDate}=require('./schema');
const SITE_URL=process.env.SITE_URL||'https://nirman.korienaureate.online';
const txt=t=>({content:[{type:'text',text:t}]});

function buildServer(store){
  const server=new McpServer({name:'nirman-ledger',version:'1.0.0'});

  server.registerTool('nirman_guide',{
    title:'Nirman Ledger: how to format entries',
    description:'Returns the sections and fields Nirman Ledger accepts, today\'s date and the site names. Call this before the first nirman_add_entries in a conversation.',
    inputSchema:{},
    annotations:{readOnlyHint:true}
  },async()=>txt(GUIDE+'\nToday is '+new Date(Date.now()+5.5*3600e3).toISOString().slice(0,10)+' (IST).'));

  server.registerTool('nirman_add_entries',{
    title:'Nirman Ledger: send entries for approval',
    description:'Send site records (DPR manpower, murum trips, incoming material, JCB/roller hours, cash payments, material registers) to the Nirman Ledger AI Inbox. '+
      'Nothing is saved to the books until the user approves it on the website, where duplicates are checked. '+
      'Split mixed pages into separate entries, one per line. Each entry: {section, date (YYYY-MM-DD), …fields}. Call nirman_guide first for the field list.',
    inputSchema:{
      entries:z.array(z.object({section:z.string().describe('One of: '+SECTIONS.join(', ')),date:z.string().describe('YYYY-MM-DD')}).passthrough())
        .min(1).max(300).describe('The lines to add'),
      note:z.string().max(2000).optional().describe('Anything uncertain, unreadable or assumed — shown to the user while reviewing'),
      source_text:z.string().max(4000).optional().describe('What the user sent (their message, or a short description of the photo)'),
      confidence:z.number().min(0).max(1).optional().describe('Your overall confidence 0–1')
    }
  },async({entries,note,source_text,confidence})=>{
    const {entries:ok,errors}=normalizeEntries(entries,'Bypass');
    if(errors.length&&!ok.length) return {isError:true,...txt('Nothing was sent. Fix these and try again:\n'+errors.join('\n'))};
    const id=await store.addInbox({status:'PENDING_REVIEW',source:'claude-chat',createdAt:new Date().toISOString(),createdBy:'Claude chat',
      text:(source_text||'').slice(0,4000),entries:JSON.stringify(ok),note:note||'',confidence:confidence==null?null:confidence});
    const bySec={}; ok.forEach(e=>{bySec[e.section]=(bySec[e.section]||0)+1;});
    return txt(`Sent ${ok.length} line(s) to the AI Inbox (${Object.entries(bySec).map(([k,v])=>k+' '+v).join(', ')}). Item id ${id}.\n`+
      (errors.length?`Skipped ${errors.length}: ${errors.join('; ')}\n`:'')+
      `Tell the user to open ${SITE_URL} → 📥 Inbox → Review & approve. Lines already in the books will show as duplicates and are not added twice.`);
  });

  server.registerTool('nirman_recent',{
    title:'Nirman Ledger: read recent entries',
    description:'Read what is already in a register for the last N days (from the latest copy the owner\'s app uploaded) — use it to avoid sending duplicates or to answer questions like "how many murum trips this week".',
    inputSchema:{
      section:z.string().describe('Register: '+SECTIONS.join(', ')+', or vouchers, purchases, trips'),
      days:z.number().int().min(1).max(400).optional().describe('How many days back (default 14)')
    },
    annotations:{readOnlyHint:true}
  },async({section,days})=>{
    const sec=String(section||'').toLowerCase();
    const col=sec==='mlog'?'machineLogs':(['vouchers','purchases','trips','sales','machineLogs'].includes(section)?section:'lb.'+sec);
    const from=new Date(Date.now()-(days||14)*864e5).toISOString().slice(0,10);
    const rows=(await store.listItems(col)).filter(r=>(isoDate(r.date)||'')>=from)
      .sort((a,b)=>(isoDate(a.date)<isoDate(b.date)?1:-1)).slice(0,300)
      .map(r=>{ const o={}; Object.keys(r).forEach(k=>{ if(k[0]!=='_'&&k!=='id'&&typeof r[k]!=='object') o[k]=r[k]; }); return o; });
    return txt(rows.length?`${rows.length} row(s) in ${col} since ${from}:\n`+rows.map(r=>JSON.stringify(r)).join('\n'):`No rows in ${col} since ${from}.`);
  });

  server.registerTool('nirman_inbox',{
    title:'Nirman Ledger: AI Inbox status',
    description:'List the latest AI Inbox items and whether the user approved or rejected them.',
    inputSchema:{limit:z.number().int().min(1).max(50).optional()},
    annotations:{readOnlyHint:true}
  },async({limit})=>{
    const list=await store.listInbox(limit||10);
    return txt(list.length?list.map(x=>`${(x.createdAt||'').slice(0,16)} · ${x.status} · ${x.source} · ${(()=>{try{return JSON.parse(x.entries||'[]').length}catch(e){return '?'}})()} line(s)`+(x.applied?' · saved: '+x.applied:'')+(x.reason?' · reason: '+x.reason:'')).join('\n'):'The inbox is empty.');
  });
  return server;
}
module.exports={buildServer};
