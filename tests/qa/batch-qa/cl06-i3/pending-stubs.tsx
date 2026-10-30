// @ts-nocheck
export * from '../../preview-audit/pending-stubs';
export const t01Audit={detail:null,menu:null,filters:[]};
export const useChangeDetails=()=>target=>{t01Audit.detail=target;};
export const action=(run,reason)=>({run,reason});
export const useContextMenu=()=> (scope,bindings)=>({onContextMenu:e=>{e.preventDefault();e.stopPropagation();t01Audit.menu={scope,items:bindings()};}});
export const filterPendingChanges=(rows,keyword)=>{t01Audit.filters.push(keyword);return rows.filter(r=>!keyword||r.description.toLowerCase().includes(keyword.toLowerCase())||String(r.id).includes(keyword));};
