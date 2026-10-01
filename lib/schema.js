/* Shared rules for what Claude may send into Nirman Ledger.
   Claude only proposes entries; the website validates again, shows them for review,
   checks duplicates and saves only what the user approves. */
const SECTIONS = ['dpr','murum','incoming','mlog','cash','gitti','msand','hava','dumper','loha','cement',
  'bindingwire','bricks','blocks','tmgitti','diesel','readymix','adhesive'];
const ALIAS = { manpower:'dpr', labour:'dpr', labor:'dpr', worker:'dpr', workers:'dpr', attendance:'dpr',
  murrum:'murum', hardmurum:'murum', earth:'murum', material:'incoming', incominggoods:'incoming', goods:'incoming',
  machine:'mlog', machinelog:'mlog', jcb:'mlog', roller:'mlog', hourmeter:'mlog', payment:'cash', cashbook:'cash',
  steel:'loha', sariya:'loha', m_sand:'msand', sand:'msand', brick:'bricks', block:'blocks', aac:'blocks', fuel:'diesel', rmc:'readymix' };

const GUIDE = [
  'Nirman Ledger — construction site books of Korien Aureate (sites: "Bypass" and "Barela", Jabalpur, MP).',
  'Send each line as one entry. Every entry needs "section" and "date" (YYYY-MM-DD). One page may mix sections — split them.',
  'Sections and fields:',
  '• dpr — daily manpower: party (worker/contractor), work, m (Mistri Ⓜ), h (Helper Ⓗ), b (Beldar Ⓑ), site, remark. NIL day → m=h=b=0, remark "NIL".',
  '• murum — murum trips: party (supplier, e.g. Madan Yadav), qty (number of trips), site, remark. NIL → qty 0, remark "NIL".',
  '• incoming — any other material received: item, qty, unit, rate, amt, party (supplier), site, remark.',
  '• mlog — JCB / roller hour-meter: mtype ("jcb" or "roller"), hmStart, hmEnd, hours, work, site.',
  '• cash — payment made: party, amt, mode ("Cash" | "Cheque" | "Online"), remark.',
  '• gitti, msand, loha, cement, bindingwire, bricks, blocks, tmgitti, diesel, readymix, adhesive — party, qty (keep the unit text, e.g. "600 cft", "50 Bag", "25 lits"), size, site, remark.',
  '• hava, dumper — trips, payment, site.',
  'Rules: keep units exactly as written — never convert cft/bags/kg. Never invent numbers; if unreadable put "?" in remark and mention it in note.',
  'Murum lines go to murum, worker lines to dpr — never to incoming. Indian dates are DD/MM/YYYY; a ditto mark means "same as the row above".',
  'DATES: read the MONTH as carefully as the day — in handwriting 2/7, 1/7, 4/9, 3/8, 6/0 are easily confused. Check each month against the page header, the neighbouring rows and the register order. '+
  'All entries fall in FY 2026-27 (1 Apr 2026 – 31 Mar 2027) and never after today. If a date still looks outside that, re-read it; if unsure, use the neighbouring rows\' month and say so in note.'
].join('\n');

function isoDate(v){
  if(!v) return '';
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m) return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
  m=s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/); if(m){ const y=m[3].length===2?'20'+m[3]:m[3]; return y+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'); }
  return '';
}
/* Returns {entries, errors}. Keeps the shape the website's splitter understands. */
function normalizeEntries(list, defaultSite){
  const entries=[], errors=[];
  (Array.isArray(list)?list:[]).forEach((e,i)=>{
    if(!e||typeof e!=='object'||Array.isArray(e)){ errors.push(`#${i+1}: not an object`); return; }
    const raw=String(e.section||'').toLowerCase().replace(/[^a-z_]/g,'');
    const section=SECTIONS.includes(raw)?raw:(ALIAS[raw.replace(/_/g,'')]||'');
    if(!section){ errors.push(`#${i+1}: unknown section "${e.section}" — use one of ${SECTIONS.join(', ')}`); return; }
    const date=isoDate(e.date);
    if(!date){ errors.push(`#${i+1}: date "${e.date}" is not a date (use YYYY-MM-DD)`); return; }
    const y=+date.slice(0,4); if(y<2020||y>2035){ errors.push(`#${i+1}: date ${date} looks wrong`); return; }
    const out={}; Object.keys(e).forEach(k=>{ const v=e[k]; if(v===undefined||v===null) return;
      if(typeof v==='object') return;                     // flat fields only
      out[k]=typeof v==='string'?v.slice(0,500):v; });
    out.section=section; out.date=date;
    if(!out.site) out.site=defaultSite||'Bypass';
    entries.push(out);
  });
  if(entries.length>300){ errors.push('Too many entries in one go (max 300)'); return {entries:[],errors}; }
  return {entries,errors};
}
module.exports={SECTIONS,GUIDE,normalizeEntries,isoDate};
