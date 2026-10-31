// @ts-nocheck -- Deliberately minimal synthetic boundaries, never production services.
import {createContext,useState} from 'react';
export const audit={reads:0,menu:null,move:null};
const initial=[0,100,2,10].map(id=>({id,description:'Synthetic CL '+id,user:'fixture',client:'synthetic',jobs:[],files:[{depotPath:'//synthetic/file-'+id,action:'edit'}],shelvedFiles:[]}));
export function usePendingCache(){const [changes,setChanges]=useState(initial);return {changes,updateChanges:setChanges,data:{stats:{scannedCount:changes.length,matchedCount:changes.length}},error:'',refresh:async()=>{audit.reads++;setChanges(v=>[...v]);}};}
export const backend=new Proxy({}, {get(){return ()=>{throw new Error('Unexpected backend call');};}});
export const useCommandFocus=()=>()=>{};
export const CommandExecutionContext=createContext(()=>{});
export const PageHeaderActionsContext=createContext(null);
export const useMenuEnvironment=()=>({runtime:{context:{},connection:{state:'connected'}},preferences:{zh:false},commandBusy:false});
export const useChangeDetails=()=>()=>{};
export const useContextMenu=()=> (scope,bindings)=>({onContextMenu:e=>{e.preventDefault();e.stopPropagation();audit.menu={scope,copy:bindings()['复制 CL 编号']};}});
export const action=()=>({}); export const copy=value=>value;
export const filterPendingChanges=rows=>rows;
export const mergePendingMutation=rows=>rows;
export const invalidateData=()=>{};
export const swarmMenuAction=()=>({});
export const pendingFilePath=file=>file.depotPath;
export const connectionPresentation=()=>({});
export const ChangelistFormDialog=()=>null;
export const ShelfDialog=()=>null;
export const UnshelveDialog=()=>null;
export function MoveFilesDialog({request}){audit.move=request;return <div role="dialog">Synthetic move {request.from} to {request.target}</div>;}
export function PendingFileList({files,changeId,onDragFiles,onDragEnd}){return <div data-files={changeId}>{files.map(file=><div key={file.depotPath} draggable onDragStart={e=>onDragFiles([file.depotPath],e)} onDragEnd={onDragEnd}>{file.depotPath}</div>)}</div>;}
