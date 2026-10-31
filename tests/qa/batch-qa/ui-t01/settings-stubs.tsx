// @ts-nocheck -- all state and operations are synthetic memory only.
export const audit={calls:[],saved:null};
const context={executable:'C:\\Synthetic\\p4.exe',server:'fixture.invalid',user:'fixture-user',client:'fixture-workspace',cwd:'C:\\Synthetic\\workspace'};
export const runtime={mode:'mock',activeProfileId:'fixture',contextGeneration:1,p4Version:'Synthetic P4',context,connection:{state:'connected',message:'synthetic',recovery:'none',server:context.server}};
let document={schemaVersion:3,revision:1,activeProfileId:'fixture',profiles:[{id:'fixture',name:'Synthetic profile',context:{...context}}]};
const status=()=>({...runtime.connection});
const workspace=name=>({name,root:'C:\\Synthetic\\'+name,rootStatus:'usable',selectable:true,owner:'fixture-user',stream:'//synthetic/main'});
const methods={
 listConnectionProfiles:async()=>structuredClone(document),
 browseConnectionUsers:async r=>({requestGeneration:r.requestGeneration,connection:status(),items:[{name:'chosen-user',fullName:'Synthetic user',email:'fixture@example.invalid'}],stats:{matchedCount:1,returnedCount:1,scannedCount:1},partial:false,truncated:false,simulated:true}),
 browseConnectionWorkspaces:async r=>({requestGeneration:r.requestGeneration,connection:status(),items:[workspace(r.prefix||'chosen-workspace')],stats:{matchedCount:1,returnedCount:1,scannedCount:1},partial:false,truncated:false,simulated:true}),
 cancelOperation:async()=>{},
 updateConnectionProfile:async r=>{audit.saved=structuredClone(r);document={...document,revision:document.revision+1,profiles:[{id:r.id,name:r.name,context:r.context}]};return structuredClone(document);},
 runtimeInfo:async()=>({...runtime,context:document.profiles[0].context,contextGeneration:2}),
 discoverP4Cli:async()=>({state:'notTested',version:'synthetic',executable:context.executable,message:'synthetic'}),
 testConnection:async()=>status(),queryLoginStatus:async()=>status(),
};
export const backend=new Proxy({}, {get:(_,name)=>(...args)=>{audit.calls.push({name,args});if(!methods[name])throw Error('Forbidden synthetic settings call: '+String(name));return methods[name](...args);}});
export const useUnsavedEditor=()=>{};
export const normalizeSwarmBaseUrl=value=>value;
export function ConnectionSpecCreateDialog(){throw Error('Create dialog is outside T01 scope');}
