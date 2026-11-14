pub mod branch_mapping_service;
pub mod changelist_service;
// CL-06: isolated planning/mock contract; no executable IPC or process adapter.
#[allow(dead_code)]
pub(crate) mod company_submit;
// Pure policy; close_guard applies the conservative document-trust adapter.
#[allow(dead_code)]
pub(crate) mod close_policy;
pub mod confirmation;
pub mod connection_service;
pub mod connection_setup_service;
pub(crate) mod custom_submit;
pub mod diagnostics;
pub mod external_merge;
pub mod file_lock_service;
pub mod file_service;
pub mod manual_merge;
pub mod preview;
pub mod rename_service;
pub mod search_service;
pub(crate) mod selected_submit;
pub mod status_cache;
pub mod stream_graph_service;
pub mod stream_switch_service;
pub mod submit_service;
pub mod swarm_open;
pub mod sync_service;
pub mod system_open;
pub mod undo_service;
pub mod url_open;
pub mod vfs_service;
pub mod workflow_service;

pub(crate) mod action_evidence;
pub(crate) mod control_plane_action;
pub(crate) mod custom_submit_action;
pub(crate) mod frontend_log;
pub(crate) mod generic_action;
pub mod local_action;
pub(crate) mod local_io_action;
pub(crate) mod merge_resolve_action;
pub(crate) mod pending_cl_action;
pub(crate) mod platform_open;
pub(crate) mod revert_action;
