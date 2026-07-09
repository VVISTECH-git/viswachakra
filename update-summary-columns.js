// One-time backfill: compute per-case summary fields and write them to the new columns on `cases`.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const MON = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function parseWfDate(str){const m=String(str||'').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);if(!m)return null;let h=+m[4];const ap=(m[6]||'').toUpperCase();if(ap==='PM'&&h<12)h+=12;if(ap==='AM'&&h===12)h=0;return new Date(+m[3],MON[m[2].toLowerCase()],+m[1],h,+m[5]);}
function parseAmt(v){const n=parseInt(String(v==null?'':v).replace(/[^0-9]/g,''),10);return isNaN(n)?0:n;}

async function fetchAll(table, cols){const out=[];let f=0;while(true){const {data,error}=await s.from(table).select(cols).range(f,f+999);if(error){console.error(error.message);break;}if(!data||!data.length)break;out.push(...data);if(data.length<1000)break;f+=1000;}return out;}

function computeCase(rows){
  rows=rows.sort((a,b)=>a.row_index-b.row_index);
  const initiated=rows.find(r=>/initiated/i.test(r.action||''))||rows[0];
  const paidRow=[...rows].reverse().find(r=>/paid/i.test(r.action||''));
  const last=rows[rows.length-1];
  const claimed=initiated?parseAmt(initiated.amount):0;
  const initAt=initiated?parseWfDate(initiated.date_time):null;
  let paid=null,paidDate=null,settlement=null,deduction=null;
  if(paidRow){
    paid=parseAmt(paidRow.amount);paidDate=paidRow.date_time||null;
    const paidAt=parseWfDate(paidRow.date_time);
    if(claimed>0)deduction=Math.max(0,claimed-paid);
    if(initAt&&paidAt){const d=Math.round((paidAt-initAt)/864e5);if(d>=0)settlement=d;}
  }
  return {
    claimed_amount:claimed||null, paid_amount:paid, paid_date:paidDate,
    settlement_days:settlement, deduction, is_paid:!!paidRow,
    latest_comment:last?(last.remarks||''):'', latest_comment_by:last?(last.role_name||last.action||''):'',
    latest_comment_date:last?(last.date_time||''):'',
  };
}

async function chunkedUpsert(rows,chunk=400){
  for(let i=0;i<rows.length;i+=chunk){
    const {error}=await s.from('cases').upsert(rows.slice(i,i+chunk),{onConflict:'case_no'});
    if(error)throw new Error('upsert failed at '+i+': '+error.message);
    process.stdout.write('  updated '+Math.min(i+chunk,rows.length)+'/'+rows.length+'\r');
  }
  console.log('');
}

(async()=>{
  console.log('Fetching cases + workflow...');
  const cases=await fetchAll('cases','case_no');
  const wf=await fetchAll('claim_workflow','case_no,row_index,date_time,action,amount,remarks,role_name');
  const byCase={};wf.forEach(r=>{(byCase[r.case_no]=byCase[r.case_no]||[]).push(r);});
  console.log(`Computing for ${cases.length} cases (${wf.length} workflow rows)...`);
  const updates=cases.map(c=>({case_no:c.case_no,...computeCase(byCase[c.case_no]||[])}));
  console.log('Writing precomputed columns to Supabase...');
  await chunkedUpsert(updates);
  console.log('Done. Summary columns populated for '+updates.length+' cases.');
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
