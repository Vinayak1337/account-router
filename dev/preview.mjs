import {createRouter,atomicJson} from '../router.mjs';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'router-stability-ui-'));
const encode=x=>`h.${Buffer.from(JSON.stringify(x)).toString('base64url')}.s`;
const names='abcdefghij'.split('');
for(const name of names){
 await mkdir(join(root,name));
 await atomicJson(join(root,name,'auth.json'),{tokens:{account_id:`test-${name}`,access_token:encode({exp:Date.now()/1000+3600,'https://api.openai.com/auth':{chatgpt_account_id:`test-${name}`}}),refresh_token:'fake-test-refresh',id_token:encode({name:({a:'Mira',b:'Avery',c:'Noor',d:'Reese',e:'Sage',f:'Rowan',g:'Kai',h:'Morgan',i:'Arden',j:'Ellis'})[name],email:`test-${name}@example.test`,'https://api.openai.com/auth':{chatgpt_subscription_active_until:new Date(Date.now()+26*86400000).toISOString(),chatgpt_plan_type:name==='b'?'go':['f','g','h','i'].includes(name)?'free':'plus'}})}});
}
let wired=true;
const router=await createRouter({strategy:'exhaust-first',freeSolRouting:false,accounts:names.map(name=>({name,home:name}))},{root,key:'isolated-stability-verification-key',persist:false,connectionRunner:async()=>({wired,provider:wired?'local_paid_accounts':'openai'}),wireRunner:async({enabled})=>{wired=enabled;return {wired,state:enabled?'configured':'disabled',message:'Isolated fixture: connection '+(enabled?'wired':'unwired')+'.'};},fetcher:async(url,o)=>{
 const id=o.headers instanceof Headers?o.headers.get('ChatGPT-Account-Id'):o.headers['ChatGPT-Account-Id'];
 if(url.includes('/models'))return Response.json({models:['gpt-6-luna','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5'].map(slug=>({slug,supported_in_api:true,visibility:'list'}))});
 if(url.endsWith('/usage'))return Response.json({plan_type:id==='test-b'?'go':['test-f','test-g','test-h','test-i'].includes(id)?'free':'plus',rate_limit:{allowed:id!=='test-c',limit_reached:id==='test-c',primary_window:id==='test-d'?null:{used_percent:id==='test-c'?100:20,reset_at:Date.now()/1000+18000,limit_window_seconds:18000}}});
 if(url.includes('rate-limit-reset-credits'))return Response.json({available_count:2,credits:[{id:'later',title:'Later reset',expires_at:new Date(Date.now()+864000000).toISOString()},{id:'earlier',title:'Earlier reset',expires_at:new Date(Date.now()+86400000).toISOString()}].map(c=>({...c,reset_type:'codex_rate_limits',is_supported_by_plan:true,status:'available'}))});
 return new Response('data: {"type":"response.completed","response":{"id":"test-response"}}\n\n',{headers:{'content-type':'text/event-stream'}});
}});
for(const a of router.accounts){a.usage=a.name==='d'?{}:{primary:{usedPercent:['c','e'].includes(a.name)?100:({a:13,b:31,f:58,g:42,h:77,i:8,j:22})[a.name]||25,resetsAt:Date.now()/1000+(a.name==='e'?-100:18000),windowMinutes:300},secondary:{usedPercent:38,resetsAt:Date.now()/1000+380000,windowMinutes:10080}};a.usageUpdatedAt=Date.now();}
for (const a of router.accounts) {
 a.credits={balance:0,unlimited:false};
 a.benefits.details={availableCount:2,updatedAt:Date.now(),error:null,credits:[{id:'earlier',status:'available',supported:true,expiryKnown:true,expiresAt:Math.floor(Date.now()/1000)+28*86400,title:'Full usage reset'}]};
}
router.server.listen(18892,'127.0.0.1',()=>console.log(JSON.stringify({port:18892,pid:process.pid,root})));
