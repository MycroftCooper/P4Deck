// @ts-nocheck -- synthetic port. Never imports a production backend.
export * from '../command-stubs';
import {backend as settingsBackend,audit as settingsAudit} from './settings-stubs';
export const launchAudit={starts:[],statusReads:0,native:[],session:null};
const params=new URLSearchParams(location.search);
const connection={profileId:'fixture',generation:'18446744073709551615',server:'fixture.invalid',user:'fixture-user',client:'fixture-workspace'};
export const backend={
 subscribeOperationEvents:async()=>()=>{},
 companySubmitConnectionSnapshot:async()=>({...connection}),
 listConnectionProfiles:async()=>{const doc=await settingsBackend.listConnectionProfiles();doc.profiles[0].context.customSubmitExecutablePath=params.get('mode')==='native'?'':'C:\\Synthetic\\submit.exe';return doc;},
 customSubmitStart:async request=>{launchAudit.starts.push(structuredClone(request));if(params.get('mode')==='transport')throw Error('Synthetic transport error');await new Promise(r=>setTimeout(r,150));return launchAudit.session={requestId:request.requestId,changeId:request.changeId,state:params.get('mode')==='error'?'notStarted':'started',executablePath:'C:\\Synthetic\\submit.exe',exitCode:null,reason:params.get('mode')==='error'?'synthetic path rejected':null};},
 customSubmitStatus:async()=>{launchAudit.statusReads++;return launchAudit.session?{...launchAudit.session,state:'outcomeUnknown',exitCode:0,reason:'synthetic parent exited; occupancy retained'}:null;},
};
export const useCommandDialogs=()=>({pending:false,element:null,open:r=>{launchAudit.native.push(r);}});
Object.assign(window,{launchAudit,settingsAudit});
