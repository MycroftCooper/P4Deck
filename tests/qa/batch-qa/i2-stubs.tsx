// @ts-nocheck -- synthetic-only I2 services and menu presentation.
export * from '../preview-audit/pending-stubs';
export const i2Audit={reads:0,mode:'ready',queue:[],menu:null,normal:[]};
export const exactSnapshot={profileId:'qa-fixture',generation:'18446744073709551615',server:'synthetic.invalid',user:'fixture',client:'synthetic'};
export const backend={companySubmitConnectionSnapshot:()=>{
 i2Audit.reads++;
 if(i2Audit.mode==='deferred')return new Promise((resolve,reject)=>i2Audit.queue.push({resolve,reject}));
 if(i2Audit.mode==='error')return Promise.reject(Error('Synthetic identity failure'));
 return Promise.resolve({...exactSnapshot,...(i2Audit.mode==='numeric'?{generation:9007199254740992}:{}),...(i2Audit.mode==='missing'?{profileId:''}:{})});
}};
export const action=(run,reason)=>({run,reason});
export const useContextMenu=()=> (scope,bindings)=>({onContextMenu:e=>{e.preventDefault();e.stopPropagation();i2Audit.menu={scope,items:bindings(),source:e.currentTarget};window.dispatchEvent(new Event('qa-menu'));}});
