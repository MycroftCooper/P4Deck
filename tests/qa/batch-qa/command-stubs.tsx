// @ts-nocheck -- synthetic boundaries only. Unused actions fail closed.
import { createContext, useContext } from 'react';
export const AuditEnvironment=createContext(null);
export const useMenuEnvironment=()=>useContext(AuditEnvironment);
const fail=()=>{throw new Error('Action outside synthetic QA scope');};
export const useContextMenu=()=>()=>({});
export const action=handler=>({handler});
export const useChangeDetails=()=>undefined;
export const useLocalPathCapabilities=()=>undefined;
export const useCommandDialogs=()=>({pending:false,element:null,open:request=>{window.qaDispatch=request;}});
export const backend={subscribeOperationEvents:async()=>()=>{},cancelOperation:fail};
export const subscribeSafely=(subscribe,onError)=>{let disposed=false;let off;Promise.resolve().then(subscribe).then(v=>{off=v;if(disposed)off?.();}).catch(onError);return()=>{disposed=true;off?.();};};
export const fileActionFeedback=fail,queryAllPendingChanges=fail,cachedPendingChanges=fail,pendingSnapshotKey=fail;
export const invalidateData=fail,isFresh=()=>false,refreshFileLockFacts=fail;
export const commandActions={},affectedPathAliases=fail,selectionRequest=fail,resolveSelection=fail;
export const compactTargets=nodes=>nodes,nodeKey=node=>node?.depotPath||node?.absolutePath||'';
export const readClipboardText=fail,writeClipboardText=fail,workspaceCache={},resolveAddress=fail;
