#[cfg(test)]
mod tests {
    use crate::{
        app::{
            branch_mapping_service::BranchMappingService, changelist_service::ChangelistService,
            connection_service::ConnectionService,
            connection_setup_service::ConnectionSetupService, file_lock_service::FileLockService,
            file_service::FileService, rename_service::RenameService,
            search_service::GlobalSearchService, status_cache::StatusCache,
            stream_graph_service::StreamGraphService, stream_switch_service::StreamSwitchService,
            submit_service::SubmitService, sync_service::SyncService,
            workflow_service::WorkflowService,
        },
        domain::{
            AuthenticationRequest, BranchImpactDirection, BranchImpactPreviewQuery,
            BranchIssueCode, BranchMappingDetailQuery, BranchMappingDraft, BranchMappingQuery,
            BranchMappingRequestErrorCode, BranchMutationConfirmation, BranchMutationFailureCode,
            BranchMutationMode, BranchMutationOutcome, BranchMutationPreflightRequest,
            BranchViewLine, BranchViewModifier, ConnectionClassicViewLine,
            ConnectionDirectoryRequest, ConnectionSpecCreateConfirmation,
            ConnectionSpecCreateOutcome, ConnectionSpecIssueCode, ConnectionState,
            ConnectionUserCreatePlan, ConnectionUserCreatePreflightRequest,
            ConnectionWorkspaceCreatePlan, ConnectionWorkspaceCreatePreflightRequest,
            ConnectionWorkspaceMapping, CreateConnectionProfileRequest,
            DeleteConnectionProfileRequest, FileAction, FileActionRequest, FileLockConfirmation,
            FileLockFailureCode, FileLockIssueCode, FileLockOperation, FileLockOutcome,
            FileLockOwnership, FileLockPreflightRequest, LoginRequest, ManualMergeOpenRequest,
            ManualMergeResolveConfirmation, ManualMergeSaveConfirmation,
            ManualMergeValidateRequest, MoveFilesPreflightRequest, OperationResult,
            OperationSource, OutputMode, P4CommandRequest, P4Context, PendingChangeMutation,
            PendingChangeMutationRequest, PendingChangeQuery, PendingChangeSort,
            RenameMoveConfirmation, RenameMoveFailureCode, RenameMoveIssueCode, RenameMoveOutcome,
            RenameMovePreflightRequest, ResolveConfirmation, ResolvePreflightRequest,
            ResolveSelection, ResolveStrategy, SetActiveConnectionProfileRequest,
            ShelfDetailRequest, ShelfFilePreviewRequest, ShelfMode, ShelfPreflightRequest,
            StreamGraphCacheFreshness, StreamGraphQuery, StreamGraphRequestErrorCode,
            StreamSwitchConfirmation, StreamSwitchFailureCode, StreamSwitchIssueCode,
            StreamSwitchMode, StreamSwitchOutcome, StreamSwitchPreflightRequest,
            SubmitConfirmation, SubmitFailureCode, SubmitOutcome, SubmitPreflightRequest,
            SwitchWorkspaceRequest, SyncConfirmRequest, SyncFailureCode, SyncOutcome,
            SyncPreviewRequest, SyncRevisionKind, SyncRevisionSpec, UnshelvePreflightRequest,
            UpdateConnectionProfileRequest, WorkflowConfirmation, WorkflowFailureCode,
            WorkflowIssueCode, WorkflowOutcome,
        },
        p4::{
            changelists::ChangelistRepository, connection_setup::ConnectionSetupRepository,
            context::ContextStore, locks::LockRepository, rename::RenameRepository,
            runner::P4Runner, submit::SubmitRepository, workflows::WorkflowRepository, workspaces,
        },
        persistence::{
            log_store::LogStore,
            operation_journal::{JournalState, OperationJournal},
        },
    };
    use serde_json::Value;
    use std::{
        collections::HashSet,
        net::SocketAddr,
        path::{Path, PathBuf},
        sync::Arc,
    };
    use uuid::Uuid;
    use zeroize::Zeroize;

    const FIXTURE_SERVER: &str = "127.0.0.1:16661";
    const FIXTURE_USER: &str = "p4deck-fixture-admin";
    const E2E_CLIENT: &str = "p4deck-fixture-e2e";
    const WRITER_CLIENT: &str = "p4deck-fixture-submit-writer";
    const READ_ONLY_CLIENT: &str = "p4deck-fixture-submit-readonly";
    const READ_ONLY_USER: &str = "p4deck-fixture-readonly";
    const FIXTURE_SERVER_ID: &str = "p4deck-fixture-local";
    const E2E_JOB: &str = "P4DECK-E2E-JOB";
    const STREAM_DEPOT: &str = "p4deck-stream-e2e";
    const STREAM_CLIENT: &str = "p4deck-fixture-stream-e2e";
    const MAIN_STREAM: &str = "//p4deck-stream-e2e/main";
    const DEV_STREAM: &str = "//p4deck-stream-e2e/dev";
    const RELEASE_STREAM: &str = "//p4deck-stream-e2e/release";
    const VIRTUAL_STREAM: &str = "//p4deck-stream-e2e/virtual";
    const TASK_STREAM: &str = "//p4deck-stream-e2e/orphan-filter-child";
    const DELETED_STREAM: &str = "//p4deck-stream-e2e/deleted";
    const LOCK_CLIENT: &str = "p4deck-fixture-lock-other";
    const LOCK_USER: &str = "p4deck-fixture-lock-user";

    struct FixtureConfig {
        context: P4Context,
        workspace_root: PathBuf,
        runtime_root: PathBuf,
    }

    #[tokio::test]
    #[ignore = "requires the isolated localhost p4d fixture; run pnpm test:e2e:p4d:win"]
    async fn localhost_fixture_exercises_application_services() {
        let config = FixtureConfig::from_environment()
            .unwrap_or_else(|error| panic!("BE-002 fixture configuration rejected: {error}"));
        let runtime_root = config.runtime_root.clone();
        let result = run_fixture_case(config).await;
        let _ = std::fs::remove_dir_all(&runtime_root);
        result.unwrap_or_else(|error| panic!("BE-002 localhost E2E failed: {error}"));
    }

    #[tokio::test]
    #[ignore = "requires the isolated localhost p4d fixture"]
    async fn localhost_fixture_diff_returns_complete_navigation_sources() {
        let config = FixtureConfig::from_environment()
            .unwrap_or_else(|error| panic!("Diff fixture configuration rejected: {error}"));
        let nonce = Uuid::new_v4().simple().to_string();
        let client = format!("p4deck-fixture-diff-{nonce}");
        let root = config
            .workspace_root
            .parent()
            .expect("validated fixture workspace parent")
            .join(format!("diff-tools-{nonce}"));
        std::fs::create_dir_all(&config.runtime_root).unwrap();
        let contexts = Arc::new(ContextStore::load(&config.runtime_root).unwrap());
        let logs = Arc::new(LogStore::open(&config.runtime_root.join("logs.sqlite")).unwrap());
        let journal = Arc::new(
            OperationJournal::open(&config.runtime_root.join("operations.sqlite")).unwrap(),
        );
        let runner = Arc::new(P4Runner::new(logs.clone(), journal.clone()));
        let files = FileService::new(
            runner.clone(),
            Arc::new(StatusCache::new(15_000, 32, 1024 * 1024)),
            journal.clone(),
            contexts.clone(),
        );
        let scenario = async {
            let context = setup_named_client(&runner, &config.context, &client, &root).await?;
            contexts
                .save(context.clone())
                .map_err(|error| error.to_string())?;
            const DEPOT: &str = "//depot/main/README.txt";
            checked_run(
                &runner,
                &context,
                "sync",
                vec![DEPOT.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let local = root.join("main/README.txt");
            make_writable(&local)?;
            let baseline = std::fs::read_to_string(&local).map_err(|error| error.to_string())?;
            let normalized = baseline.replace("\r\n", "\n");
            ensure(
                normalized.ends_with('\n'),
                "fixture seed must end in a newline",
            )?;
            let scope = crate::domain::FileReviewScope {
                server: context.server.clone(),
                user: context.user.clone(),
                client: client.clone(),
                workspace: context.cwd.clone().unwrap(),
                active_profile_id: contexts.active_profile_id(),
                context_generation: contexts.snapshot().1,
                file_identity: DEPOT.into(),
            };
            let mut canonical_left = None;
            let mut last = None;
            for (index, (contents, additions, deletions)) in [
                (baseline, 0, 0),
                (normalized.clone(), 0, 0),
                (normalized.replace('\n', "\r\n"), 0, 0),
                (format!("{normalized}local navigation tools\n"), 1, 0),
                (normalized.strip_suffix('\n').unwrap().to_owned(), 1, 1),
            ]
            .into_iter()
            .enumerate()
            {
                std::fs::write(&local, &contents).map_err(|error| error.to_string())?;
                let result = files
                    .diff(
                        crate::domain::DiffRequest {
                            right_file_identity: None,
                            scope: scope.clone(),
                            left: crate::domain::RevisionReference::Have,
                            right: crate::domain::RevisionReference::Workspace,
                            refresh: true,
                            operation_id: Some(format!("diff-tools-{index}")),
                        },
                        None,
                    )
                    .await?;
                ensure(
                    result
                        .left_text
                        .as_deref()
                        .is_some_and(|text| text.replace("\r\n", "\n") == normalized)
                        && result.right_text.as_deref() == Some(contents.as_str())
                        && result.stats.additions == additions
                        && result.stats.deletions == deletions
                        && result.identical == (additions == 0 && deletions == 0)
                        && !result.partial
                        && !result.truncated,
                    format!("complete diff text or newline semantics failed for case {index}"),
                )?;
                if let Some(left) = &canonical_left {
                    ensure(
                        result.left_text.as_ref() == Some(left),
                        "revision source changed",
                    )?;
                } else {
                    canonical_left = result.left_text.clone();
                }
                last = Some(result);
            }
            let cached = files
                .diff(
                    crate::domain::DiffRequest {
                        right_file_identity: None,
                        scope,
                        left: crate::domain::RevisionReference::Have,
                        right: crate::domain::RevisionReference::Workspace,
                        refresh: false,
                        operation_id: Some("diff-tools-cached".into()),
                    },
                    None,
                )
                .await?;
            let last = last.unwrap();
            ensure(
                cached.left_text == last.left_text
                    && cached.right_text == last.right_text
                    && cached.operation_ids == last.operation_ids,
                "cached diff lost its sources or repeated P4 operations",
            )
        }
        .await;
        let cleanup = cleanup_named_client(&runner, &config.context, &client, &root).await;
        drop((files, runner, logs, journal, contexts));
        let _ = std::fs::remove_dir_all(&config.runtime_root);
        scenario
            .and(cleanup)
            .unwrap_or_else(|error| panic!("Diff fixture failed: {error}"));
    }

    #[tokio::test]
    #[ignore = "requires the isolated localhost p4d fixture"]
    async fn localhost_fixture_connection_setup_uses_explicit_draft_context() {
        const USER: &str = "p4deck-setup-self-e2e";
        const CLASSIC: &str = "p4deck-setup-classic-e2e";
        const STALE: &str = "p4deck-setup-stale-e2e";
        const STREAM_CLIENT_NAME: &str = "p4deck-setup-stream-e2e";
        const DEPOT: &str = "p4deck-setup-stream-depot-e2e";
        const STREAM: &str = "//p4deck-setup-stream-depot-e2e/main";

        let config = FixtureConfig::from_environment()
            .unwrap_or_else(|error| panic!("connection setup fixture rejected: {error}"));
        std::fs::create_dir_all(&config.runtime_root).unwrap();
        let logs =
            Arc::new(LogStore::open(&config.runtime_root.join("setup-logs.sqlite")).unwrap());
        let journal = Arc::new(
            OperationJournal::open(&config.runtime_root.join("setup-operations.sqlite")).unwrap(),
        );
        let runner = Arc::new(P4Runner::new(logs.clone(), journal.clone()));
        let repository = ConnectionSetupRepository::new(runner.clone());
        let service = ConnectionSetupService::new(repository.clone());
        let mut draft = config.context.clone();
        draft.client.clear();

        let classic_root = config.workspace_root.join("connection-setup-classic");
        let stream_root = config.workspace_root.join("connection-setup-stream");
        let stale_root = config.workspace_root.join("connection-setup-stale");
        let _ = cleanup_named_client(&runner, &config.context, CLASSIC, &classic_root).await;
        let _ =
            cleanup_named_client(&runner, &config.context, STREAM_CLIENT_NAME, &stream_root).await;
        let _ = cleanup_named_client(&runner, &config.context, STALE, &stale_root).await;
        let _ = checked_run(
            &runner,
            &config.context,
            "stream",
            vec!["-d".into(), STREAM.into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            &runner,
            &config.context,
            "depot",
            vec!["-d".into(), DEPOT.into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            &runner,
            &config.context,
            "user",
            vec!["-d".into(), "-f".into(), USER.into()],
            None,
            OutputMode::Text,
        )
        .await;

        let scenario = async {
            let users = service
                .browse_users(
                    ConnectionDirectoryRequest {
                        context: draft.clone(),
                        request_generation: 11,
                        operation_id: Some("setup-users".into()),
                        prefix: Some("p4deck-fixture".into()),
                    },
                    None,
                )
                .await;
            if users.connection.state != ConnectionState::Connected
                || !users.items.iter().any(|item| item.name == FIXTURE_USER)
            {
                return Err("draft User browse did not query the fixture server".into());
            }
            let workspaces = service
                .browse_workspaces(
                    ConnectionDirectoryRequest {
                        context: draft.clone(),
                        request_generation: 12,
                        operation_id: Some("setup-workspaces".into()),
                        prefix: Some("p4deck-fixture".into()),
                    },
                    None,
                )
                .await;
            if workspaces.connection.state != ConnectionState::Connected {
                return Err("draft Workspace browse required an existing client unexpectedly".into());
            }

            let (existed_before, _) = repository
                .user_exists(&config.context, USER, "setup-user-before", None)
                .await?;
            if existed_before {
                return Err("temporary setup user unexpectedly existed before preflight".into());
            }
            let mut user_context = draft.clone();
            user_context.user = USER.into();
            let user_preflight = service
                .preflight_user(
                    ConnectionUserCreatePreflightRequest {
                        context: user_context.clone(),
                        request_generation: 13,
                        operation_id: Some("setup-user-preflight".into()),
                        plan: ConnectionUserCreatePlan {
                            name: USER.into(),
                            full_name: "P4Deck Setup Self".into(),
                            email: "p4deck-setup@example.test".into(),
                        },
                    },
                    None,
                )
                .await;
            eprintln!(
                "connection-setup NewUser preflight ready={} blockers={:?}",
                user_preflight.ready, user_preflight.blockers
            );
            let (exists_after_reads, _) = repository
                .user_exists(&config.context, USER, "setup-user-after-read", None)
                .await?;
            if exists_after_reads {
                return Err("read-only New User preflight unexpectedly auto-created the user".into());
            }
            if user_preflight.ready {
                let user_result = service
                    .confirm(
                        crate::domain::ConnectionSpecKind::UserSelf,
                        ConnectionSpecCreateConfirmation {
                            token: user_preflight.token.clone().unwrap(),
                            operation_id: None,
                            context: user_context,
                            request_generation: 13,
                            state_digest: user_preflight.state_digest,
                            confirmed: true,
                        },
                        None,
                    )
                    .await;
                eprintln!(
                    "connection-setup NewUser confirm outcome={:?} failure={:?}",
                    user_result.outcome, user_result.failure
                );
                if !matches!(
                    user_result.outcome,
                    ConnectionSpecCreateOutcome::Created | ConnectionSpecCreateOutcome::Rejected
                ) {
                    return Err("New User returned an ambiguous result without a transport failure".into());
                }
            } else if user_preflight.blockers.iter().any(|issue| {
                issue.code == ConnectionSpecIssueCode::AlreadyExists
                    || issue.code == ConnectionSpecIssueCode::InvalidInput
            }) {
                return Err("New User was blocked for an unsafe or unexpected reason".into());
            }

            std::fs::create_dir_all(&classic_root).map_err(|error| error.to_string())?;
            let classic_plan = ConnectionWorkspaceCreatePlan {
                name: CLASSIC.into(),
                root: classic_root.to_string_lossy().into_owned(),
                description: Some("P4Deck connection setup classic fixture".into()),
                mapping: ConnectionWorkspaceMapping::Classic {
                    view: vec![ConnectionClassicViewLine {
                        depot_path: "//depot/...".into(),
                        client_path: format!("//{CLASSIC}/..."),
                    }],
                },
                sync_mode: crate::domain::WorkspaceSyncMode::Standard,
            };
            create_fixture_workspace(&service, &draft, 14, classic_plan.clone()).await?;
            let context_store = Arc::new(
                ContextStore::load(&config.runtime_root.join("root-resolution"))
                    .map_err(|error| error.to_string())?,
            );
            let connection = ConnectionService::new(
                context_store.clone(),
                repository.clone(),
                logs.clone(),
                journal.clone(),
            );
            let mut wrong_draft = draft.clone();
            wrong_draft.client = CLASSIC.into();
            // This directory exists, but it is not the selected client's server-owned Root.
            wrong_draft.cwd = Some(config.workspace_root.to_string_lossy().into_owned());
            let created_profiles = connection
                .create_profile(
                    CreateConnectionProfileRequest {
                        operation_id: None,
                        expected_revision: 0,
                        name: "Root resolution fixture".into(),
                        context: wrong_draft.clone(),
                    },
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            let profile = created_profiles
                .profiles
                .first()
                .ok_or("Root resolution profile was not created")?;
            if PathBuf::from(profile.context.cwd.as_deref().unwrap_or_default())
                .canonicalize()
                .map_err(|error| error.to_string())?
                != classic_root
                    .canonicalize()
                    .map_err(|error| error.to_string())?
            {
                return Err("first-active create accepted the wrong existing draft cwd".into());
            }
            let updated = connection
                .update_profile(
                    UpdateConnectionProfileRequest {
                        operation_id: None,
                        expected_revision: created_profiles.revision,
                        id: profile.id.clone(),
                        name: profile.name.clone(),
                        context: wrong_draft.clone(),
                    },
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            if PathBuf::from(updated.profiles[0].context.cwd.as_deref().unwrap_or_default())
                .canonicalize()
                .map_err(|error| error.to_string())?
                != classic_root
                    .canonicalize()
                    .map_err(|error| error.to_string())?
            {
                return Err("active update accepted the wrong existing draft cwd".into());
            }
            let saved = connection
                .save(wrong_draft, None)
                .await
                .map_err(|error| error.to_string())?;
            if PathBuf::from(saved.cwd.as_deref().unwrap_or_default())
                .canonicalize()
                .map_err(|error| error.to_string())?
                != classic_root
                    .canonicalize()
                    .map_err(|error| error.to_string())?
            {
                return Err("active save accepted the wrong existing draft cwd".into());
            }
            let (classic_before_duplicate, _) = repository
                .read_workspace(
                    &config.context,
                    CLASSIC,
                    "setup-classic-before-duplicate",
                    None,
                )
                .await?;
            let duplicate = service
                .preflight_workspace(
                    ConnectionWorkspaceCreatePreflightRequest {
                        context: draft.clone(),
                        request_generation: 15,
                        operation_id: Some("setup-classic-duplicate".into()),
                        plan: classic_plan,
                    },
                    None,
                )
                .await;
            if duplicate.ready
                || !duplicate
                    .blockers
                    .iter()
                    .any(|issue| issue.code == ConnectionSpecIssueCode::AlreadyExists)
            {
                return Err("existing classic workspace was not refused".into());
            }
            let (classic_after_duplicate, _) = repository
                .read_workspace(
                    &config.context,
                    CLASSIC,
                    "setup-classic-after-duplicate",
                    None,
                )
                .await?;
            if classic_before_duplicate != classic_after_duplicate {
                return Err("duplicate workspace preflight changed the existing spec".into());
            }

            std::fs::create_dir_all(&stale_root).map_err(|error| error.to_string())?;
            let stale_preflight = service
                .preflight_workspace(
                    ConnectionWorkspaceCreatePreflightRequest {
                        context: draft.clone(),
                        request_generation: 20,
                        operation_id: Some("setup-stale-preflight".into()),
                        plan: ConnectionWorkspaceCreatePlan {
                            name: STALE.into(),
                            root: stale_root.to_string_lossy().into_owned(),
                            description: Some("P4Deck stale token fixture".into()),
                            mapping: ConnectionWorkspaceMapping::Classic {
                                view: vec![ConnectionClassicViewLine {
                                    depot_path: "//depot/...".into(),
                                    client_path: format!("//{STALE}/..."),
                                }],
                            },
                            sync_mode: crate::domain::WorkspaceSyncMode::Standard,
                        },
                    },
                    None,
                )
                .await;
            if !stale_preflight.ready {
                return Err("stale-token preflight was unexpectedly blocked".into());
            }
            let stale_confirmation = ConnectionSpecCreateConfirmation {
                token: stale_preflight.token.clone().unwrap(),
                operation_id: None,
                context: draft.clone(),
                request_generation: 21,
                state_digest: stale_preflight.state_digest,
                confirmed: true,
            };
            let stale_result = service
                .confirm(
                    crate::domain::ConnectionSpecKind::Workspace,
                    stale_confirmation.clone(),
                    None,
                )
                .await;
            if stale_result.outcome != ConnectionSpecCreateOutcome::Rejected
                || stale_result.failure != Some(ConnectionSpecIssueCode::ConnectionChanged)
            {
                return Err("changed draft generation did not invalidate the token".into());
            }
            let replay = service
                .confirm(
                    crate::domain::ConnectionSpecKind::Workspace,
                    stale_confirmation,
                    None,
                )
                .await;
            if replay.outcome != ConnectionSpecCreateOutcome::Rejected {
                return Err("consumed setup token was replayable".into());
            }
            let (stale_exists, _) = repository
                .workspace_exists(&config.context, STALE, "setup-stale-verify", None)
                .await?;
            if stale_exists {
                return Err("stale or replayed confirmation wrote a workspace".into());
            }

            checked_run(
                &runner,
                &config.context,
                "depot",
                vec!["-i".into()],
                Some(format!("Depot: {DEPOT}\nOwner: {FIXTURE_USER}\nType: stream\nStreamDepth: 1\nMap: {DEPOT}/...\n")),
                OutputMode::Text,
            )
            .await?;
            checked_run(
                &runner,
                &config.context,
                "stream",
                vec!["-i".into()],
                Some(format!("Stream: {STREAM}\nOwner: {FIXTURE_USER}\nName: main\nParent: none\nType: mainline\nParentView: inherit\nOptions: allsubmit unlocked notoparent nofromparent mergedown\nPaths:\n\tshare ...\n")),
                OutputMode::Text,
            )
            .await?;
            std::fs::create_dir_all(&stream_root).map_err(|error| error.to_string())?;
            create_fixture_workspace(
                &service,
                &draft,
                16,
                ConnectionWorkspaceCreatePlan {
                    name: STREAM_CLIENT_NAME.into(),
                    root: stream_root.to_string_lossy().into_owned(),
                    description: Some("P4Deck connection setup stream fixture".into()),
                    mapping: ConnectionWorkspaceMapping::Stream {
                        stream: STREAM.into(),
                    },
                    sync_mode: crate::domain::WorkspaceSyncMode::Standard,
                },
            )
            .await?;
            Ok::<(), String>(())
        }
        .await;

        let _ = cleanup_named_client(&runner, &config.context, CLASSIC, &classic_root).await;
        let _ =
            cleanup_named_client(&runner, &config.context, STREAM_CLIENT_NAME, &stream_root).await;
        let _ = cleanup_named_client(&runner, &config.context, STALE, &stale_root).await;
        let _ = checked_run(
            &runner,
            &config.context,
            "stream",
            vec!["-d".into(), STREAM.into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            &runner,
            &config.context,
            "depot",
            vec!["-d".into(), DEPOT.into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            &runner,
            &config.context,
            "user",
            vec!["-d".into(), "-f".into(), USER.into()],
            None,
            OutputMode::Text,
        )
        .await;
        drop((service, repository, runner, logs, journal));
        let _ = std::fs::remove_dir_all(&config.runtime_root);
        scenario.unwrap_or_else(|error| panic!("connection setup fixture failed: {error}"));
    }

    async fn create_fixture_workspace(
        service: &ConnectionSetupService,
        context: &P4Context,
        generation: u64,
        plan: ConnectionWorkspaceCreatePlan,
    ) -> Result<(), String> {
        let preflight = service
            .preflight_workspace(
                ConnectionWorkspaceCreatePreflightRequest {
                    context: context.clone(),
                    request_generation: generation,
                    operation_id: Some(format!("setup-workspace-{generation}")),
                    plan,
                },
                None,
            )
            .await;
        if !preflight.ready {
            return Err(format!(
                "workspace preflight blocked: {:?}",
                preflight.blockers
            ));
        }
        let result = service
            .confirm(
                crate::domain::ConnectionSpecKind::Workspace,
                ConnectionSpecCreateConfirmation {
                    token: preflight.token.unwrap(),
                    operation_id: None,
                    context: context.clone(),
                    request_generation: generation,
                    state_digest: preflight.state_digest,
                    confirmed: true,
                },
                None,
            )
            .await;
        if result.outcome != ConnectionSpecCreateOutcome::Created {
            return Err(format!("workspace creation was not verified: {result:?}"));
        }
        Ok(())
    }

    impl FixtureConfig {
        fn from_environment() -> Result<Self, String> {
            if std::env::var("P4DECK_E2E").as_deref() != Ok("1") {
                return Err(
                    "P4DECK_E2E=1 is missing; use scripts/test-p4d-e2e.ps1 so user P4 settings cannot leak into this test"
                        .into(),
                );
            }
            let executable = required_path("P4DECK_E2E_P4", true)?;
            let server = required("P4DECK_E2E_SERVER")?;
            let address: SocketAddr = server
                .parse()
                .map_err(|_| format!("server is not an IP socket address: {server}"))?;
            if server != FIXTURE_SERVER || !address.ip().is_loopback() || address.port() != 16661 {
                return Err(format!(
                    "server must be the fixed loopback target {FIXTURE_SERVER}, got {server}"
                ));
            }
            let user = required("P4DECK_E2E_USER")?;
            if user != FIXTURE_USER {
                return Err(format!("unexpected fixture user: {user}"));
            }
            let client = required("P4DECK_E2E_CLIENT")?;
            if client != E2E_CLIENT {
                return Err(format!("unexpected fixture client: {client}"));
            }
            let tickets = required_path("P4DECK_E2E_TICKETS", true)?;
            let trust = required_path("P4DECK_E2E_TRUST", false)?;
            let workspace_root = required_path("P4DECK_E2E_ROOT", false)?;
            let fixture_root = executable
                .parent()
                .and_then(Path::parent)
                .ok_or("fixture executable is not under a fixture root")?;
            for (label, path) in [
                ("tickets", tickets.as_path()),
                ("trust", trust.as_path()),
                ("workspace", workspace_root.as_path()),
            ] {
                if !path.starts_with(fixture_root) {
                    return Err(format!(
                        "{label} path escapes the fixture root: {}",
                        path.display()
                    ));
                }
            }
            let runtime_root =
                std::env::temp_dir().join(format!("p4deck-e2e-{}", uuid::Uuid::new_v4()));
            Ok(Self {
                context: P4Context {
                    executable: Some(executable.to_string_lossy().into_owned()),
                    server,
                    user,
                    client,
                    cwd: Some(workspace_root.to_string_lossy().into_owned()),
                    // The fixture is a non-Unicode server. P4CHARSET=none is isolated by the
                    // launcher; passing `-C none` would instead select a Unicode client mode.
                    charset: None,
                    trust_path: Some(trust.to_string_lossy().into_owned()),
                    tickets_path: Some(tickets.to_string_lossy().into_owned()),
                    swarm_base_url: None,
                    custom_submit_executable_path: String::new(),
                },
                workspace_root,
                runtime_root,
            })
        }
    }

    async fn run_fixture_case(config: FixtureConfig) -> Result<(), String> {
        std::fs::create_dir_all(&config.runtime_root).map_err(|error| error.to_string())?;
        let contexts =
            Arc::new(ContextStore::load(&config.runtime_root).map_err(|error| error.to_string())?);
        let logs = Arc::new(LogStore::open(&config.runtime_root.join("logs.sqlite"))?);
        let journal = Arc::new(OperationJournal::open(
            &config.runtime_root.join("operations.sqlite"),
        )?);
        let runner = Arc::new(P4Runner::new(logs.clone(), journal.clone()));
        let connection = Arc::new(ConnectionService::new(
            contexts.clone(),
            ConnectionSetupRepository::new(runner.clone()),
            logs.clone(),
            journal.clone(),
        ));
        let context = config.context.clone();
        let status_cache = Arc::new(StatusCache::new(15_000, 512, 16 * 1024 * 1024));
        let changelists = Arc::new(ChangelistService::new(
            ChangelistRepository::new(runner.clone()),
            status_cache.clone(),
            contexts.clone(),
        ));
        let search =
            GlobalSearchService::new(runner.clone(), changelists.clone(), contexts.clone());
        let submit = SubmitService::new(
            SubmitRepository::new(runner.clone()),
            contexts.clone(),
            status_cache.clone(),
        );
        let expiring_submit = SubmitService::with_ttl(
            SubmitRepository::new(runner.clone()),
            contexts.clone(),
            status_cache.clone(),
            1,
        );
        let sync = SyncService::new(runner.clone(), contexts.clone(), status_cache.clone());
        let expiring_sync =
            SyncService::with_ttl(runner.clone(), contexts.clone(), status_cache.clone(), 1);
        let workflows = WorkflowService::new(
            WorkflowRepository::new(runner.clone()),
            contexts.clone(),
            status_cache.clone(),
        );
        let expiring_workflows = WorkflowService::with_ttl(
            WorkflowRepository::new(runner.clone()),
            contexts.clone(),
            status_cache.clone(),
            1,
        );
        let files = FileService::new(
            runner.clone(),
            status_cache.clone(),
            journal.clone(),
            contexts.clone(),
        );
        let rename = RenameService::new(
            RenameRepository::new(runner.clone()),
            contexts.clone(),
            status_cache.clone(),
        );
        let file_locks = FileLockService::new(
            LockRepository::new(runner.clone()),
            contexts.clone(),
            status_cache.clone(),
        );
        let expiring_rename = RenameService::with_ttl(
            RenameRepository::new(runner.clone()),
            contexts.clone(),
            status_cache.clone(),
            1,
        );
        let stream_switch = Arc::new(StreamSwitchService::new(runner.clone(), contexts.clone()));
        let stream_graph = Arc::new(StreamGraphService::new(runner.clone(), contexts.clone()));
        let branch_mappings = Arc::new(BranchMappingService::new(runner.clone(), contexts.clone()));
        let expiring_stream_switch = Arc::new(StreamSwitchService::with_ttl(
            runner.clone(),
            contexts.clone(),
            1,
        ));

        let _ = cleanup_client(&runner, &context, &config.workspace_root).await;
        let setup = setup_client(&runner, &context, &config.workspace_root).await;
        let profile_root = config
            .workspace_root
            .parent()
            .ok_or("fixture workspace has no parent")?
            .join("profile-switch-workspace");
        const PROFILE_CLIENT: &str = "p4deck-fixture-profile-switch";
        let scenario = match setup {
            Ok(()) => {
                async {
                    // Saving resolves the server-owned Root, so the client must
                    // exist before the connection can be persisted.
                    connection
                        .save(context.clone(), None)
                        .await
                        .map_err(|error| error.to_string())?;
                    let profile_context =
                        setup_named_client(&runner, &context, PROFILE_CLIENT, &profile_root)
                            .await?;
                    exercise_connection_profiles(
                        &connection,
                        &contexts,
                        &runner,
                        &context,
                        &profile_context,
                        &profile_root,
                    )
                    .await?;
                    exercise_services(
                        ServiceExercise {
                            connection: &connection,
                            runner: &runner,
                            files: &files,
                            changelists: &changelists,
                            journal: &journal,
                            logs: &logs,
                            submit: &submit,
                            expiring_submit: &expiring_submit,
                            sync: &sync,
                            expiring_sync: &expiring_sync,
                            contexts: &contexts,
                            workflows: &workflows,
                            expiring_workflows: &expiring_workflows,
                            search: &search,
                            rename: &rename,
                            expiring_rename: &expiring_rename,
                            file_locks: &file_locks,
                            stream_graph: &stream_graph,
                            branch_mappings: &branch_mappings,
                            stream_switch: &stream_switch,
                            expiring_stream_switch: &expiring_stream_switch,
                        },
                        &context,
                        &config.workspace_root,
                    )
                    .await
                }
                .await
            }
            Err(error) => Err(error),
        };
        let profile_cleanup =
            cleanup_named_client(&runner, &context, PROFILE_CLIENT, &profile_root).await;
        let cleanup = cleanup_client(&runner, &context, &config.workspace_root).await;
        let stream_root = config
            .workspace_root
            .parent()
            .map(|parent| parent.join("stream-switch-workspace"))
            .unwrap_or_else(|| config.workspace_root.join("stream-switch-workspace"));
        let stream_cleanup = cleanup_stream_fixture(&runner, &context, &stream_root).await;

        drop(files);
        drop(rename);
        drop(runner);
        drop(logs);
        drop(journal);
        drop(connection);

        match (scenario, cleanup.and(profile_cleanup).and(stream_cleanup)) {
            (Err(error), Err(cleanup_error)) => {
                Err(format!("{error}; cleanup also failed: {cleanup_error}"))
            }
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(format!("cleanup failed: {error}")),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    async fn exercise_connection_profiles(
        connection: &ConnectionService,
        contexts: &ContextStore,
        runner: &P4Runner,
        original: &P4Context,
        alternate: &P4Context,
        alternate_root: &Path,
    ) -> Result<(), String> {
        let initial = connection.profiles();
        let original_id = initial
            .active_profile_id
            .clone()
            .ok_or("profile E2E has no active profile")?;
        let created = connection
            .create_profile(
                CreateConnectionProfileRequest {
                    operation_id: None,
                    expected_revision: initial.revision,
                    name: "Fixture alternate".into(),
                    context: alternate.clone(),
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        let alternate_id = created
            .profiles
            .iter()
            .find(|profile| profile.id != original_id)
            .ok_or("alternate profile was not created")?
            .id
            .clone();
        let before_generation = contexts.snapshot().1;
        let active = connection
            .set_active_profile(
                SetActiveConnectionProfileRequest {
                    operation_id: None,
                    expected_revision: created.revision,
                    id: alternate_id.clone(),
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure(
            active.context.client == alternate.client
                && active.context_generation > before_generation,
            "active profile switch did not commit the verified alternate context",
        )?;

        let current = connection.profiles();
        let mut unavailable = original.clone();
        unavailable.executable = Some(
            alternate_root
                .join("missing-p4.exe")
                .to_string_lossy()
                .into_owned(),
        );
        unavailable.client = "unavailable-profile".into();
        let with_bad = connection
            .create_profile(
                CreateConnectionProfileRequest {
                    operation_id: None,
                    expected_revision: current.revision,
                    name: "Unavailable".into(),
                    context: unavailable,
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        let bad_id = with_bad
            .profiles
            .iter()
            .find(|profile| profile.name == "Unavailable")
            .ok_or("unavailable profile was not created")?
            .id
            .clone();
        let failed = connection
            .set_active_profile(
                SetActiveConnectionProfileRequest {
                    operation_id: None,
                    expected_revision: with_bad.revision,
                    id: bad_id.clone(),
                },
                None,
            )
            .await;
        ensure(
            failed.is_err(),
            "unavailable profile switch unexpectedly succeeded",
        )?;
        ensure(
            connection.profiles().active_profile_id.as_deref() == Some(&alternate_id)
                && connection.context().client == alternate.client,
            "failed profile switch changed the active runtime context",
        )?;

        let before_return = connection.profiles();
        connection
            .set_active_profile(
                SetActiveConnectionProfileRequest {
                    operation_id: None,
                    expected_revision: before_return.revision,
                    id: original_id.clone(),
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        let revision = connection.profiles().revision;
        let cleaned = connection
            .delete_profile(DeleteConnectionProfileRequest {
                operation_id: None,
                expected_revision: revision,
                id: bad_id,
            })
            .map_err(|error| error.to_string())?;
        let cleaned = connection
            .delete_profile(DeleteConnectionProfileRequest {
                operation_id: None,
                expected_revision: cleaned.revision,
                id: alternate_id,
            })
            .map_err(|error| error.to_string())?;
        ensure(
            cleaned.active_profile_id.as_deref() == Some(&original_id),
            "profile cleanup changed the active profile",
        )?;

        let listed = workspaces::list(runner, original.clone(), None).await?;
        ensure(
            listed
                .iter()
                .any(|workspace| workspace.name == original.client)
                && listed
                    .iter()
                    .any(|workspace| workspace.name == alternate.client),
            "profile E2E did not expose both server-side clients",
        )?;
        let workspace_generation = contexts.snapshot().1;
        let switched = connection
            .switch_workspace(
                SwitchWorkspaceRequest {
                    expected_generation: workspace_generation,
                    client: alternate.client.clone(),
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure(
            switched.context.client == alternate.client
                && switched.context.cwd.as_deref()
                    == Some(
                        alternate_root
                            .canonicalize()
                            .map_err(|error| error.to_string())?
                            .to_string_lossy()
                            .as_ref(),
                    ),
            "workspace switch did not update both Client and Root",
        )?;
        let stale = connection
            .switch_workspace(
                SwitchWorkspaceRequest {
                    expected_generation: workspace_generation,
                    client: original.client.clone(),
                },
                None,
            )
            .await;
        ensure(stale.is_err(), "stale workspace generation was accepted")?;

        let returned = connection
            .switch_workspace(
                SwitchWorkspaceRequest {
                    expected_generation: switched.context_generation,
                    client: original.client.clone(),
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure(
            returned.context.client == original.client,
            "workspace E2E did not restore the original Client",
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn exercise_rename_state_machine(
        rename: &RenameService,
        expiring_rename: &RenameService,
        contexts: &ContextStore,
        runner: &P4Runner,
        files: &FileService,
        changelists: &ChangelistService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let source = root.join("main").join("README.txt");
        let target = root.join("main").join("README-renamed-e2e.txt");
        let request = |target_path: &Path, target_change_id| RenameMovePreflightRequest {
            source_path: source.to_string_lossy().into_owned(),
            target_path: target_path.to_string_lossy().into_owned(),
            target_change_id,
            operation_id: None,
        };

        let unopened = rename.preflight(request(&target, 0), None).await;
        ensure(
            unopened
                .blockers
                .iter()
                .any(|item| item.code == RenameMoveIssueCode::SourceNotOpened),
            format!("unopened source was not blocked: {unopened:?}"),
        )?;
        action(
            files,
            context,
            FileAction::Checkout,
            vec![source.to_string_lossy().into_owned()],
        )
        .await?;

        std::fs::write(&target, b"must not be overwritten\n").map_err(|error| error.to_string())?;
        let exists = rename.preflight(request(&target, 0), None).await;
        ensure(
            exists
                .blockers
                .iter()
                .any(|item| item.code == RenameMoveIssueCode::TargetExists),
            format!("existing target was not blocked: {exists:?}"),
        )?;
        std::fs::remove_file(&target).map_err(|error| error.to_string())?;

        let outside = root
            .parent()
            .ok_or("fixture workspace has no parent")?
            .join("rename-outside.txt");
        let unmapped = rename.preflight(request(&outside, 0), None).await;
        ensure(
            unmapped.blockers.iter().any(|item| {
                matches!(
                    item.code,
                    RenameMoveIssueCode::TargetUnmapped | RenameMoveIssueCode::CrossWorkspace
                )
            }),
            format!("out-of-mapping target was not blocked: {unmapped:?}"),
        )?;

        let case_target = root.join("main").join("readme.txt");
        let case_only = rename.preflight(request(&case_target, 0), None).await;
        ensure(
            case_only
                .blockers
                .iter()
                .any(|item| item.code == RenameMoveIssueCode::CaseOnlyRename),
            format!("case-only Windows rename was not blocked: {case_only:?}"),
        )?;

        let expiring = expiring_rename.preflight(request(&target, 0), None).await;
        ensure(
            expiring.ready && expiring.token.is_some(),
            format!("expiring rename preview was not ready: {expiring:?}"),
        )?;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let expired = expiring_rename
            .confirm(
                RenameMoveConfirmation {
                    token: expiring.token.ok_or("expiring preview had no token")?,
                    target: expiring
                        .target_snapshot
                        .ok_or("expiring preview had no target")?,
                    preview_digest: expiring.preview_digest,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            expired.failure == Some(RenameMoveFailureCode::TokenExpired),
            format!("expired rename token was not rejected: {expired:?}"),
        )?;

        let drift = rename.preflight(request(&target, 0), None).await;
        contexts
            .save(context.clone())
            .map_err(|error| error.to_string())?;
        let drifted = rename
            .confirm(
                RenameMoveConfirmation {
                    token: drift.token.ok_or("generation preview had no token")?,
                    target: drift
                        .target_snapshot
                        .ok_or("generation preview had no target")?,
                    preview_digest: drift.preview_digest,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            drifted.failure == Some(RenameMoveFailureCode::ContextChanged),
            format!("rename generation drift was not rejected: {drifted:?}"),
        )?;

        let target_change =
            create_numbered_change(changelists, context, "BE-002R rename target").await?;
        let ready = rename
            .preflight(request(&target, target_change), None)
            .await;
        ensure(
            ready.ready && ready.token.is_some() && ready.target_snapshot.is_some(),
            format!("rename preview was not ready: {ready:?}"),
        )?;
        let confirmation = RenameMoveConfirmation {
            token: ready.token.ok_or("rename preview had no token")?,
            target: ready
                .target_snapshot
                .ok_or("rename preview had no target")?,
            preview_digest: ready.preview_digest,
            operation_id: Some("rename-e2e-success".into()),
        };
        let moved = rename.confirm(confirmation.clone(), None).await;
        ensure(
            moved.outcome == RenameMoveOutcome::Succeeded
                && moved.refresh.workspace_status
                && moved.refresh.pending_changes,
            format!("confirmed rename failed or omitted refresh hints: {moved:?}"),
        )?;
        ensure(
            !source.exists() && target.is_file(),
            "p4 move did not rename the workspace file",
        )?;
        let move_status = files
            .workspace_children(
                context.clone(),
                Some(root.join("main").to_string_lossy().into_owned()),
                true,
                None,
            )
            .await?;
        ensure(
            move_status
                .items
                .iter()
                .any(|node| node.name == "README-renamed-e2e.txt" && node.state == "openedMoveAdd")
                && move_status
                    .items
                    .iter()
                    .any(|node| node.name == "README.txt" && node.state == "openedMoveDelete"),
            format!("move pair status was not preserved: {move_status:?}"),
        )?;
        let opened = checked_run(
            runner,
            context,
            "opened",
            vec!["//depot/main/README-renamed-e2e.txt".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let target_change_text = target_change.to_string();
        ensure(
            json_values(&opened).iter().any(|value| {
                value.get("change").and_then(Value::as_str) == Some(target_change_text.as_str())
            }),
            format!("p4 move did not use target change {target_change}: {opened:?}"),
        )?;
        let replayed = rename.confirm(confirmation, None).await;
        ensure(
            replayed.failure == Some(RenameMoveFailureCode::TokenUnknown),
            format!("rename token replay was not rejected: {replayed:?}"),
        )?;
        checked_run(
            runner,
            context,
            "revert",
            vec![
                "//depot/main/README.txt".into(),
                "//depot/main/README-renamed-e2e.txt".into(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        ensure(
            source.is_file() && !target.exists(),
            "reverting the E2E move did not restore the fixture",
        )?;
        delete_empty_change(changelists, context, target_change).await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn exercise_file_lock_state_machine(
        runner: &Arc<P4Runner>,
        files: &FileService,
        changelists: &ChangelistService,
        locks: &FileLockService,
        contexts: &Arc<ContextStore>,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        const NORMAL: &str = "//depot/p4deck-lock-e2e/normal.txt";
        const EXCLUSIVE: &str = "//depot/p4deck-lock-e2e/exclusive.bin";

        let other_root = root
            .parent()
            .ok_or("lock fixture workspace has no parent")?
            .join("lock-other-workspace");
        let other_context_root =
            std::env::temp_dir().join(format!("p4deck-lock-context-{}", Uuid::new_v4()));
        let local_dir = root.join("p4deck-lock-e2e");
        let normal_local = local_dir.join("normal.txt");
        let exclusive_local = local_dir.join("exclusive.bin");
        let mut other = context.clone();
        other.user = LOCK_USER.into();
        other.client = LOCK_CLIENT.into();
        other.cwd = Some(other_root.to_string_lossy().into_owned());

        let scenario = async {
            let user_form = format!(
                "User: {LOCK_USER}\nEmail: lock@fixture.invalid\nFullName: P4Deck lock fixture\n"
            );
            checked_run(
                runner,
                context,
                "user",
                vec!["-f".into(), "-i".into()],
                Some(user_form),
                OutputMode::Text,
            )
            .await?;
            fixture_passwd(
                context,
                Some(LOCK_USER),
                "p4deck-lock-initial\np4deck-lock-initial\n".into(),
            )
            .await?;
            std::fs::create_dir_all(&other_root).map_err(|error| error.to_string())?;
            let client_form = format!(
                "Client: {LOCK_CLIENT}\nOwner: {LOCK_USER}\nRoot: {}\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nLineEnd: local\nView:\n\t//depot/... //{LOCK_CLIENT}/...\n",
                other_root.to_string_lossy().replace('\\', "/")
            );
            checked_run(
                runner,
                context,
                "client",
                vec!["-i".into()],
                Some(client_form),
                OutputMode::Text,
            )
            .await?;
            fixture_passwd(
                &other,
                None,
                "p4deck-lock-initial\np4deck-lock-local\np4deck-lock-local\n".into(),
            )
            .await?;
            let login = crate::p4::connection::ConnectionAdapter::execute(
                &other,
                crate::p4::connection::ConnectionOperation::Login,
                None,
                Some("p4deck-lock-local"),
            )
            .await;
            ensure(
                login.state == ConnectionState::Connected,
                format!("lock fixture login failed: {login:?}"),
            )?;

            std::fs::create_dir_all(&local_dir).map_err(|error| error.to_string())?;
            std::fs::write(&normal_local, b"lock fixture\n")
                .map_err(|error| error.to_string())?;
            std::fs::write(&exclusive_local, b"exclusive fixture\n")
                .map_err(|error| error.to_string())?;
            checked_run(
                runner,
                context,
                "add",
                vec!["-t".into(), "text".into(), NORMAL.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                context,
                "add",
                vec!["-t".into(), "binary+l".into(), EXCLUSIVE.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                context,
                "submit",
                vec!["-d".into(), "P4Deck lock fixture seed".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &other,
                "sync",
                vec![NORMAL.into(), EXCLUSIVE.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                context,
                "edit",
                vec![NORMAL.into(), EXCLUSIVE.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let exclusive_fstat = checked_run(
                runner,
                context,
                "fstat",
                vec!["-T".into(), "depotFile,action,type,headType".into(), EXCLUSIVE.into()],
                None,
                OutputMode::JsonLines,
            )
            .await?;
            ensure(
                json_values(&exclusive_fstat).iter().any(|value| {
                    value.get("action").and_then(Value::as_str) == Some("edit")
                        && value
                            .get("type")
                            .or_else(|| value.get("headType"))
                            .and_then(Value::as_str)
                            == Some("binary+l")
                }),
                format!("binary+l fixture was not opened with its authoritative type: {exclusive_fstat:?}"),
            )?;
            checked_run(
                runner,
                &other,
                "edit",
                vec![NORMAL.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let other_change_form = format!(
                "Change: new\nClient: {LOCK_CLIENT}\nUser: {LOCK_USER}\nStatus: new\nDescription:\n\tP4Deck other-owner lock fixture\n"
            );
            let other_change_result = checked_run(
                runner,
                &other,
                "change",
                vec!["-i".into()],
                Some(other_change_form),
                OutputMode::Text,
            )
            .await?;
            let other_change_id =
                crate::p4::changelists::parser::parse_created_change_id(&other_change_result)
                    .ok_or_else(|| {
                    format!(
                        "other-owner lock fixture did not create a numbered changelist: {other_change_result:?}"
                    )
                })?;
            checked_run(
                runner,
                &other,
                "reopen",
                vec!["-c".into(), other_change_id.to_string(), NORMAL.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let _ = checked_run(
                runner,
                &other,
                "edit",
                vec![EXCLUSIVE.into()],
                None,
                OutputMode::Text,
            )
            .await;
            let exclusive_opens = checked_run(
                runner,
                context,
                "opened",
                vec!["-a".into(), EXCLUSIVE.into()],
                None,
                OutputMode::JsonLines,
            )
            .await?;
            ensure(
                json_values(&exclusive_opens).iter().all(|value| {
                    value.get("client").and_then(Value::as_str) != Some(LOCK_CLIENT)
                }),
                format!("binary+l file was opened by a second client: {exclusive_opens:?}"),
            )?;

            let drift = locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Lock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-generation".into()),
                    },
                    None,
                )
                .await;
            ensure(drift.ready, format!("lock drift preflight failed: {drift:?}"))?;
            contexts
                .save(context.clone())
                .map_err(|error| error.to_string())?;
            let drifted = locks
                .confirm(lock_confirmation(drift, "lock-e2e-generation-confirm")?, None)
                .await;
            ensure(
                drifted.failure == Some(FileLockFailureCode::ContextChanged),
                format!("lock generation drift was accepted: {drifted:?}"),
            )?;

            let preflight = locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Lock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-main".into()),
                    },
                    None,
                )
                .await;
            ensure(
                preflight.ready
                    && preflight.files[0].ownership == FileLockOwnership::Unlocked,
                format!("normal lock preflight failed: {preflight:?}"),
            )?;
            let confirmation = lock_confirmation(preflight, "lock-e2e-main-confirm")?;
            let locked = locks.confirm(confirmation.clone(), None).await;
            ensure(
                locked.outcome == FileLockOutcome::Succeeded
                    && locked.files[0].ownership == FileLockOwnership::Ours,
                format!("normal lock failed final verification: {locked:?}"),
            )?;
            let replayed = locks.confirm(confirmation, None).await;
            ensure(
                replayed.failure == Some(FileLockFailureCode::TokenUnknown),
                format!("lock token replay was accepted: {replayed:?}"),
            )?;

            let status = files
                .workspace_children(
                    context.clone(),
                    Some(local_dir.to_string_lossy().into_owned()),
                    true,
                    None,
                )
                .await?;
            ensure(
                status.items.iter().any(|node| {
                    node.name == "normal.txt"
                        && node.status.lock_ownership == Some(FileLockOwnership::Ours)
                        && node.status.can_unlock == Some(true)
                }) && status.items.iter().any(|node| {
                    node.name == "exclusive.bin"
                        && node.status.exclusive_open == Some(true)
                        && node.status.file_type.as_deref() == Some("binary+l")
                }),
                format!("workspace lock/+l status was not aggregated: {status:?}"),
            )?;
            let pending = changelists.query_pending(context.clone(), None).await?;
            let pending_files = pending
                .iter()
                .flat_map(|change| change.files.iter())
                .collect::<Vec<_>>();
            ensure(
                pending_files.iter().any(|file| {
                    file.depot_path == NORMAL
                        && file.lock_ownership == Some(FileLockOwnership::Ours)
                }) && pending_files.iter().any(|file| {
                    file.depot_path == EXCLUSIVE && file.exclusive_open == Some(true)
                }),
                format!("Pending lock/+l status was not aggregated: {pending_files:?}"),
            )?;

            std::fs::create_dir_all(&other_context_root).map_err(|error| error.to_string())?;
            let other_contexts = Arc::new(
                ContextStore::load(&other_context_root).map_err(|error| error.to_string())?,
            );
            other_contexts
                .save(other.clone())
                .map_err(|error| error.to_string())?;
            let other_locks = FileLockService::new(
                LockRepository::new(runner.clone()),
                other_contexts.clone(),
                Arc::new(StatusCache::new(15_000, 64, 2 * 1024 * 1024)),
            );
            let conflict = other_locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Lock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-other-conflict".into()),
                    },
                    None,
                )
                .await;
            ensure(
                !conflict.ready
                    && conflict.blockers.iter().any(|item| {
                        item.code == FileLockIssueCode::LockedByOther
                            && item.message.contains("Another user")
                    })
                    && conflict.files[0]
                        .lock_owner
                        .as_deref()
                        .is_some_and(|owner| owner.contains(E2E_CLIENT)),
                format!("other-client lock conflict was not explicit: {conflict:?}"),
            )?;

            let unlock = locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Unlock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-unlock".into()),
                    },
                    None,
                )
                .await;
            let unlocked = locks
                .confirm(lock_confirmation(unlock, "lock-e2e-unlock-confirm")?, None)
                .await;
            ensure(
                unlocked.outcome == FileLockOutcome::Succeeded
                    && unlocked.files[0].ownership == FileLockOwnership::Unlocked,
                format!("unlock did not verify final state: {unlocked:?}"),
            )?;

            let stale = locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Lock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-toctou".into()),
                    },
                    None,
                )
                .await;
            let other_ready = other_locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Lock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-other".into()),
                    },
                    None,
                )
                .await;
            let other_locked = other_locks
                .confirm(
                    lock_confirmation(other_ready, "lock-e2e-other-confirm")?,
                    None,
                )
                .await;
            ensure(
                other_locked.outcome == FileLockOutcome::Succeeded,
                format!("other-client lock failed: {other_locked:?}"),
            )?;
            let changed = locks
                .confirm(lock_confirmation(stale, "lock-e2e-toctou-confirm")?, None)
                .await;
            ensure(
                changed.failure == Some(FileLockFailureCode::StateChanged),
                format!("lock TOCTOU ownership drift was accepted: {changed:?}"),
            )?;

            let ordinary_admin_unlock = locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Unlock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-other-owner-rejection".into()),
                    },
                    None,
                )
                .await;
            ensure(
                !ordinary_admin_unlock.ready
                    && ordinary_admin_unlock
                        .blockers
                        .iter()
                        .any(|issue| issue.code == FileLockIssueCode::LockedByOther),
                format!("ordinary unlock accepted another owner's lock: {ordinary_admin_unlock:?}"),
            )?;

            let other_unlock = other_locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Unlock,
                        paths: vec![NORMAL.into()],
                        operation_id: Some("lock-e2e-other-unlock".into()),
                    },
                    None,
                )
                .await;
            let other_unlocked = other_locks
                .confirm(
                    lock_confirmation(other_unlock, "lock-e2e-other-unlock-confirm")?,
                    None,
                )
                .await;
            ensure(
                other_unlocked.outcome == FileLockOutcome::Succeeded
                    && other_unlocked.files[0].ownership == FileLockOwnership::Unlocked,
                format!("other-client unlock failed: {other_unlocked:?}"),
            )?;

            let exclusive = locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Lock,
                        paths: vec![EXCLUSIVE.into()],
                        operation_id: Some("lock-e2e-exclusive".into()),
                    },
                    None,
                )
                .await;
            ensure(
                exclusive.ready && exclusive.files[0].exclusive,
                format!("binary+l preflight was not explicit: {exclusive:?}"),
            )?;
            let exclusive_locked = locks
                .confirm(
                    lock_confirmation(exclusive, "lock-e2e-exclusive-confirm")?,
                    None,
                )
                .await;
            ensure(
                exclusive_locked.outcome == FileLockOutcome::Succeeded,
                format!("binary+l lock failed: {exclusive_locked:?}"),
            )?;
            let exclusive_unlock = locks
                .preflight(
                    FileLockPreflightRequest {
                        operation: FileLockOperation::Unlock,
                        paths: vec![EXCLUSIVE.into()],
                        operation_id: Some("lock-e2e-exclusive-unlock".into()),
                    },
                    None,
                )
                .await;
            let exclusive_unlocked = locks
                .confirm(
                    lock_confirmation(exclusive_unlock, "lock-e2e-exclusive-unlock-confirm")?,
                    None,
                )
                .await;
            ensure(
                exclusive_unlocked.outcome == FileLockOutcome::Succeeded,
                format!("binary+l unlock failed: {exclusive_unlocked:?}"),
            )?;
            Ok(())
        }
        .await;

        let _ = checked_run(
            runner,
            &other,
            "revert",
            vec!["-w".into(), "//depot/p4deck-lock-e2e/...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            runner,
            context,
            "revert",
            vec!["-w".into(), "//depot/p4deck-lock-e2e/...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        delete_pending_for_client(runner, context, LOCK_USER, LOCK_CLIENT).await;
        let client_cleanup = checked_run(
            runner,
            context,
            "client",
            vec!["-d".into(), "-f".into(), LOCK_CLIENT.into()],
            None,
            OutputMode::Text,
        )
        .await
        .map(|_| ());
        let user_cleanup = checked_run(
            runner,
            context,
            "user",
            vec!["-d".into(), "-f".into(), LOCK_USER.into()],
            None,
            OutputMode::Text,
        )
        .await
        .map(|_| ());
        let depot_cleanup = checked_run(
            runner,
            context,
            "obliterate",
            vec!["-y".into(), "//depot/p4deck-lock-e2e/...".into()],
            None,
            OutputMode::Text,
        )
        .await
        .map(|_| ());
        for path in [&other_root, &other_context_root] {
            if path.exists() {
                let _ = std::fs::remove_dir_all(path);
            }
        }
        match (
            scenario,
            client_cleanup.and(user_cleanup).and(depot_cleanup),
        ) {
            (Err(error), Err(cleanup)) => Err(format!("{error}; lock cleanup failed: {cleanup}")),
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(format!("lock cleanup failed: {error}")),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    fn lock_confirmation(
        preflight: crate::domain::FileLockPreflight,
        operation_id: &str,
    ) -> Result<FileLockConfirmation, String> {
        Ok(FileLockConfirmation {
            token: preflight.token.ok_or("lock preflight returned no token")?,
            target: preflight
                .target_snapshot
                .ok_or("lock preflight returned no target")?,
            state_digest: preflight.state_digest,
            operation_id: Some(operation_id.into()),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn exercise_sync_state_machine(
        runner: &Arc<P4Runner>,
        files: &FileService,
        sync: &SyncService,
        expiring_sync: &SyncService,
        contexts: &ContextStore,
        journal: &OperationJournal,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let readme = vec!["//depot/main/README.txt".to_owned()];
        let replay = sync
            .preview(sync_request(readme.clone(), None, false), None)
            .await;
        ensure(
            replay.ready && replay.token.is_some(),
            format!("up-to-date sync preview was not ready: {replay:?}"),
        )?;
        let confirmation = SyncConfirmRequest {
            token: replay.token.clone().expect("checked above"),
            target: replay.target.clone(),
            acknowledge_force: false,
            operation_id: Some("sync-e2e-replay".into()),
        };
        let first = sync.confirm(confirmation.clone(), None).await;
        ensure(
            first.outcome == SyncOutcome::Succeeded,
            format!("up-to-date confirmed sync failed: {first:?}"),
        )?;
        let replayed = sync.confirm(confirmation, None).await;
        ensure(
            replayed.failure == Some(SyncFailureCode::TokenUnknown),
            format!("sync token replay was not rejected: {replayed:?}"),
        )?;

        let tampered = sync
            .preview(sync_request(readme.clone(), None, false), None)
            .await;
        let mut wrong_target = tampered.target.clone();
        wrong_target.force = true;
        let tampered_result = sync
            .confirm(
                SyncConfirmRequest {
                    token: tampered.token.ok_or("tamper preview had no token")?,
                    target: wrong_target,
                    acknowledge_force: true,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            tampered_result.failure == Some(SyncFailureCode::TargetMismatch),
            format!("tampered sync target was not rejected: {tampered_result:?}"),
        )?;

        let expiring = expiring_sync
            .preview(sync_request(readme.clone(), None, false), None)
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let expired = expiring_sync
            .confirm(
                SyncConfirmRequest {
                    token: expiring.token.ok_or("expiring sync preview had no token")?,
                    target: expiring.target,
                    acknowledge_force: false,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            expired.failure == Some(SyncFailureCode::TokenExpired),
            format!("expired sync token was not rejected: {expired:?}"),
        )?;

        let switched = sync
            .preview(sync_request(readme.clone(), None, false), None)
            .await;
        contexts
            .save(context.clone())
            .map_err(|error| error.to_string())?;
        let switched_result = sync
            .confirm(
                SyncConfirmRequest {
                    token: switched.token.ok_or("generation preview had no token")?,
                    target: switched.target,
                    acknowledge_force: false,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            switched_result.failure == Some(SyncFailureCode::ContextChanged),
            format!("sync generation drift was not rejected: {switched_result:?}"),
        )?;

        let invalid = sync
            .preview(
                SyncPreviewRequest {
                    paths: readme,
                    revision: SyncRevisionSpec {
                        kind: SyncRevisionKind::Change,
                        value: Some("42 --force".into()),
                    },
                    force: false,
                    parallel_threads: None,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            !invalid.ready
                && invalid.token.is_none()
                && invalid
                    .blockers
                    .iter()
                    .any(|item| item.code == crate::domain::SyncIssueCode::InvalidTarget),
            format!("invalid sync revision was not blocked: {invalid:?}"),
        )?;

        const SYNC_WRITER: &str = "p4deck-fixture-sync-writer";
        let writer_root = root
            .parent()
            .ok_or("E2E workspace has no fixture parent")?
            .join("sync-writer-workspace");
        let writer = setup_named_client(runner, context, SYNC_WRITER, &writer_root).await?;
        let scenario = async {
            let writer_file = writer_root.join("p4deck-sync-e2e").join("state.txt");
            std::fs::create_dir_all(writer_file.parent().expect("sync file has a parent"))
                .map_err(|error| error.to_string())?;
            std::fs::write(&writer_file, b"revision one\n").map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "add",
                vec![writer_file.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "P4Deck sync E2E revision one".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let depot_path = "//depot/p4deck-sync-e2e/state.txt".to_owned();
            let local_file = root.join("p4deck-sync-e2e").join("state.txt");
            let added = sync
                .preview(sync_request(vec![depot_path.clone()], None, false), None)
                .await;
            ensure(
                added.ready && added.counts.added == 1,
                format!("new-file sync preview was not classified as add: {added:?}"),
            )?;
            confirmed_sync(sync, vec![depot_path.clone()], None).await?;
            ensure(
                std::fs::read_to_string(&local_file)
                    .map_err(|error| error.to_string())?
                    .trim_end()
                    == "revision one",
                "sync did not materialize revision one",
            )?;

            checked_run(
                runner,
                &writer,
                "edit",
                vec![writer_file.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            std::fs::write(&writer_file, b"revision two\n").map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "P4Deck sync E2E revision two".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let updated = sync
                .preview(sync_request(vec![depot_path.clone()], None, false), None)
                .await;
            ensure(
                updated.ready && updated.counts.updated == 1,
                format!("outdated sync preview was not classified as update: {updated:?}"),
            )?;
            let out_of_date = files
                .workspace_children(
                    context.clone(),
                    Some(
                        local_file
                            .parent()
                            .expect("sync file has a parent")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                    true,
                    None,
                )
                .await?;
            ensure(
                out_of_date
                    .items
                    .iter()
                    .any(|node| node.name == "state.txt" && node.state == "outOfDate"),
                format!("workspace out-of-date status was not exposed: {out_of_date:?}"),
            )?;
            confirmed_sync(sync, vec![depot_path.clone()], None).await?;
            ensure(
                std::fs::read_to_string(&local_file)
                    .map_err(|error| error.to_string())?
                    .trim_end()
                    == "revision two",
                "sync did not update workspace content to revision two",
            )?;

            confirmed_sync(
                sync,
                vec![depot_path.clone()],
                Some(SyncRevisionSpec {
                    kind: SyncRevisionKind::Revision,
                    value: Some("1".into()),
                }),
            )
            .await?;
            ensure(
                std::fs::read_to_string(&local_file)
                    .map_err(|error| error.to_string())?
                    .trim_end()
                    == "revision one",
                "revision-targeted sync did not restore revision one",
            )?;
            confirmed_sync(sync, vec![depot_path.clone()], None).await?;

            make_writable(&local_file)?;
            std::fs::write(&local_file, b"local writable change\n")
                .map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "edit",
                vec![writer_file.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            std::fs::write(&writer_file, b"revision three\n").map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "P4Deck sync E2E revision three".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let writable = sync
                .preview(sync_request(vec![depot_path.clone()], None, false), None)
                .await;
            ensure(
                !writable.ready
                    && writable
                        .blockers
                        .iter()
                        .any(|item| item.code == crate::domain::SyncIssueCode::WritableClobber),
                format!("writable/clobber risk was not blocked: {writable:?}"),
            )?;
            std::fs::remove_file(&local_file).map_err(|error| error.to_string())?;
            confirmed_sync(sync, vec![depot_path.clone()], None).await?;

            std::fs::remove_file(&local_file).map_err(|error| error.to_string())?;
            let force = sync
                .preview(sync_request(vec![depot_path.clone()], None, true), None)
                .await;
            let force_rejected = sync
                .confirm(
                    SyncConfirmRequest {
                        token: force.token.ok_or("force preview had no token")?,
                        target: force.target,
                        acknowledge_force: false,
                        operation_id: None,
                    },
                    None,
                )
                .await;
            ensure(
                force_rejected.failure == Some(SyncFailureCode::ForceAcknowledgementRequired),
                format!("force sync did not require second confirmation: {force_rejected:?}"),
            )?;
            let force = sync
                .preview(sync_request(vec![depot_path.clone()], None, true), None)
                .await;
            let forced = sync
                .confirm(
                    SyncConfirmRequest {
                        token: force.token.ok_or("second force preview had no token")?,
                        target: force.target,
                        acknowledge_force: true,
                        operation_id: Some("sync-e2e-journal".into()),
                    },
                    None,
                )
                .await;
            ensure(
                forced.outcome == SyncOutcome::Succeeded
                    && journal
                        .get("sync-e2e-journal")
                        .is_some_and(|record| record.state == JournalState::Succeeded),
                format!("confirmed force sync or Journal record failed: {forced:?}"),
            )?;

            checked_run(
                runner,
                &writer,
                "sync",
                vec![depot_path.clone()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "delete",
                vec![writer_file.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "P4Deck sync E2E delete".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let deleted = sync
                .preview(sync_request(vec![depot_path.clone()], None, false), None)
                .await;
            ensure(
                deleted.ready && deleted.counts.deleted == 1,
                format!("delete sync preview was not classified: {deleted:?}"),
            )?;
            confirmed_sync(sync, vec![depot_path], None).await?;
            ensure(!local_file.exists(), "sync did not remove the deleted file")
        }
        .await;
        let _ = cleanup_named_client(runner, context, SYNC_WRITER, &writer_root).await;
        let _ = checked_run(
            runner,
            context,
            "obliterate",
            vec!["-y".into(), "//depot/p4deck-sync-e2e/...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        scenario
    }

    async fn setup_client(
        runner: &Arc<P4Runner>,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let root = root.to_string_lossy().replace('\\', "/");
        let spec = format!(
            "Client: {E2E_CLIENT}\nOwner: {FIXTURE_USER}\nRoot: {root}\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nLineEnd: local\nView:\n\t//depot/... //{E2E_CLIENT}/...\n"
        );
        checked_run(
            runner,
            context,
            "client",
            vec!["-i".into()],
            Some(spec),
            OutputMode::Text,
        )
        .await?;
        Ok(())
    }

    async fn cleanup_client(
        runner: &P4Runner,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let _ = checked_run(
            runner,
            context,
            "revert",
            vec!["-w".into(), "//...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        if let Ok(changes) = checked_run(
            runner,
            context,
            "changes",
            vec![
                "-s".into(),
                "pending".into(),
                "-u".into(),
                FIXTURE_USER.into(),
                "-c".into(),
                E2E_CLIENT.into(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await
        {
            for change_id in json_values(&changes).into_iter().filter_map(|value| {
                value
                    .get("change")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<i64>().ok())
            }) {
                let _ = checked_run(
                    runner,
                    context,
                    "shelve",
                    vec!["-d".into(), "-c".into(), change_id.to_string()],
                    None,
                    OutputMode::Text,
                )
                .await;
                let _ = checked_run(
                    runner,
                    context,
                    "change",
                    vec!["-d".into(), change_id.to_string()],
                    None,
                    OutputMode::Text,
                )
                .await;
            }
        }
        let _ = checked_run(
            runner,
            context,
            "job",
            vec!["-d".into(), E2E_JOB.into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            runner,
            context,
            "obliterate",
            vec!["-y".into(), "//depot/p4deck-submit-e2e/...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            runner,
            context,
            "obliterate",
            vec!["-y".into(), "//depot/p4deck-workflow-e2e/...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            runner,
            context,
            "obliterate",
            vec!["-y".into(), "//depot/p4deck-sync-e2e/...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        let deletion = checked_run(
            runner,
            context,
            "client",
            vec!["-d".into(), "-f".into(), E2E_CLIENT.into()],
            None,
            OutputMode::Text,
        )
        .await;
        if root.exists() {
            std::fs::remove_dir_all(root).map_err(|error| error.to_string())?;
        }
        match deletion {
            Ok(_) => Ok(()),
            Err(error) if error.to_ascii_lowercase().contains("doesn't exist") => Ok(()),
            Err(error) if error.to_ascii_lowercase().contains("does not exist") => Ok(()),
            Err(error) => Err(error),
        }
    }

    async fn setup_stream_fixture(
        runner: &P4Runner,
        base: &P4Context,
        root: &Path,
    ) -> Result<P4Context, String> {
        cleanup_stream_fixture(runner, base, root).await?;
        std::fs::create_dir_all(root).map_err(|error| error.to_string())?;

        let depot_spec = format!(
            "Depot: {STREAM_DEPOT}\nOwner: {FIXTURE_USER}\nDescription:\n\tP4Deck isolated stream-switch fixture.\nType: stream\nStreamDepth: 1\nMap: {STREAM_DEPOT}/...\n"
        );
        checked_run(
            runner,
            base,
            "depot",
            vec!["-i".into()],
            Some(depot_spec),
            OutputMode::Text,
        )
        .await?;

        let main_spec = format!(
            "Stream: {MAIN_STREAM}\nOwner: {FIXTURE_USER}\nName: main\nParent: none\nType: mainline\nParentView: inherit\nDescription:\n\tP4Deck global-search-fixture stream-switch mainline.\nOptions: allsubmit unlocked notoparent nofromparent mergedown\nPaths:\n\tshare ...\n"
        );
        checked_run(
            runner,
            base,
            "stream",
            vec!["-i".into()],
            Some(main_spec),
            OutputMode::Text,
        )
        .await?;
        let release_spec = format!(
            "Stream: {RELEASE_STREAM}\nOwner: {FIXTURE_USER}\nName: release\nParent: {MAIN_STREAM}\nType: release\nParentView: noinherit\nDescription:\n\tP4Deck Stream Graph release 流.\nOptions: ownersubmit unlocked notoparent fromparent mergedown\nPaths:\n\tshare ...\n"
        );
        checked_run(
            runner,
            base,
            "stream",
            vec!["-i".into()],
            Some(release_spec),
            OutputMode::Text,
        )
        .await?;
        let dev_spec = format!(
            "Stream: {DEV_STREAM}\nOwner: {FIXTURE_USER}\nName: dev\nParent: {MAIN_STREAM}\nType: development\nParentView: inherit\nDescription:\n\tP4Deck stream-switch development stream.\nOptions: allsubmit unlocked toparent fromparent mergedown\nPaths:\n\tshare ...\n"
        );
        checked_run(
            runner,
            base,
            "stream",
            vec!["-i".into()],
            Some(dev_spec),
            OutputMode::Text,
        )
        .await?;
        let virtual_spec = format!(
            "Stream: {VIRTUAL_STREAM}\nOwner: {FIXTURE_USER}\nName: virtual\nParent: {DEV_STREAM}\nType: virtual\nParentView: inherit\nDescription:\n\tP4Deck Stream Graph virtual stream.\nOptions: allsubmit unlocked notoparent nofromparent mergedown\nPaths:\n\tshare ...\n"
        );
        checked_run(
            runner,
            base,
            "stream",
            vec!["-i".into()],
            Some(virtual_spec),
            OutputMode::Text,
        )
        .await?;
        let task_spec = format!(
            "Stream: {TASK_STREAM}\nOwner: {FIXTURE_USER}\nName: orphan-filter-child\nParent: {DEV_STREAM}\nType: task\nParentView: inherit\nDescription:\n\tP4Deck Stream Graph orphan-filter-child Unicode 子流.\nOptions: allsubmit unlocked toparent fromparent mergedown\nPaths:\n\tshare ...\n"
        );
        checked_run(
            runner,
            base,
            "stream",
            vec!["-i".into()],
            Some(task_spec),
            OutputMode::Text,
        )
        .await?;
        let deleted_spec = format!(
            "Stream: {DELETED_STREAM}\nOwner: {FIXTURE_USER}\nName: deleted\nParent: {MAIN_STREAM}\nType: development\nParentView: inherit\nDescription:\n\tP4Deck deleted Stream Graph fixture.\nOptions: allsubmit unlocked toparent fromparent mergedown\nPaths:\n\tshare ...\n"
        );
        checked_run(
            runner,
            base,
            "stream",
            vec!["-i".into()],
            Some(deleted_spec),
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            base,
            "stream",
            vec!["-d".into(), DELETED_STREAM.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        let mut context = base.clone();
        context.client = STREAM_CLIENT.into();
        context.cwd = Some(root.to_string_lossy().into_owned());
        let client_spec = format!(
            "Client: {STREAM_CLIENT}\nOwner: {FIXTURE_USER}\nRoot: {}\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nSubmitOptions: submitunchanged\nLineEnd: local\nStream: {MAIN_STREAM}\n",
            root.to_string_lossy().replace('\\', "/")
        );
        checked_run(
            runner,
            &context,
            "client",
            vec!["-i".into()],
            Some(client_spec),
            OutputMode::Text,
        )
        .await?;

        let file = root.join("stream-switch.txt");
        std::fs::write(&file, b"main\n").map_err(|error| error.to_string())?;
        checked_run(
            runner,
            &context,
            "add",
            vec![file.to_string_lossy().into_owned()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &context,
            "submit",
            vec!["-d".into(), "P4Deck stream-switch main seed".into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &context,
            "populate",
            vec![
                "-r".into(),
                "-S".into(),
                DEV_STREAM.into(),
                "-d".into(),
                "P4Deck stream-switch child seed".into(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &context,
            "client",
            vec![
                "-s".into(),
                "-S".into(),
                DEV_STREAM.into(),
                STREAM_CLIENT.into(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &context,
            "sync",
            vec![format!("//{STREAM_CLIENT}/...#head")],
            None,
            OutputMode::Text,
        )
        .await?;
        make_writable(&file)?;
        checked_run(
            runner,
            &context,
            "edit",
            vec![file.to_string_lossy().into_owned()],
            None,
            OutputMode::Text,
        )
        .await?;
        std::fs::write(&file, b"dev\n").map_err(|error| error.to_string())?;
        checked_run(
            runner,
            &context,
            "submit",
            vec!["-d".into(), "P4Deck stream-switch child edit".into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &context,
            "client",
            vec![
                "-s".into(),
                "-S".into(),
                MAIN_STREAM.into(),
                STREAM_CLIENT.into(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &context,
            "sync",
            vec![format!("//{STREAM_CLIENT}/...#head")],
            None,
            OutputMode::Text,
        )
        .await?;
        ensure(
            std::fs::read_to_string(&file)
                .map_err(|error| error.to_string())?
                .trim_end()
                == "main",
            "stream fixture did not restore the mainline content",
        )?;
        Ok(context)
    }

    async fn cleanup_stream_fixture(
        runner: &P4Runner,
        base: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let mut context = base.clone();
        context.client = STREAM_CLIENT.into();
        context.cwd = Some(root.to_string_lossy().into_owned());
        let _ = checked_run(
            runner,
            &context,
            "revert",
            vec!["-w".into(), "//...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        delete_pending_for_client(runner, base, FIXTURE_USER, STREAM_CLIENT).await;
        let _ = checked_run(
            runner,
            base,
            "client",
            vec!["-d".into(), "-f".into(), STREAM_CLIENT.into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            runner,
            base,
            "obliterate",
            vec!["-y".into(), format!("//{STREAM_DEPOT}/...")],
            None,
            OutputMode::Text,
        )
        .await;
        for stream in [
            TASK_STREAM,
            VIRTUAL_STREAM,
            RELEASE_STREAM,
            DEV_STREAM,
            DELETED_STREAM,
            MAIN_STREAM,
        ] {
            let _ = checked_run(
                runner,
                base,
                "stream",
                vec!["-f".into(), "-d".into(), stream.into()],
                None,
                OutputMode::Text,
            )
            .await;
            let _ = checked_run(
                runner,
                base,
                "stream",
                vec![
                    "-f".into(),
                    "--obliterate".into(),
                    "-y".into(),
                    stream.into(),
                ],
                None,
                OutputMode::Text,
            )
            .await;
        }
        let deletion = checked_run(
            runner,
            base,
            "depot",
            vec!["-d".into(), STREAM_DEPOT.into()],
            None,
            OutputMode::Text,
        )
        .await;
        if root.exists() {
            std::fs::remove_dir_all(root).map_err(|error| error.to_string())?;
        }
        match deletion {
            Ok(_) => Ok(()),
            Err(error) if error.to_ascii_lowercase().contains("doesn't exist") => Ok(()),
            Err(error) if error.to_ascii_lowercase().contains("does not exist") => Ok(()),
            Err(error) => Err(error),
        }
    }

    struct ServiceExercise<'a> {
        connection: &'a ConnectionService,
        runner: &'a Arc<P4Runner>,
        files: &'a FileService,
        changelists: &'a ChangelistService,
        journal: &'a OperationJournal,
        logs: &'a LogStore,
        submit: &'a SubmitService,
        expiring_submit: &'a SubmitService,
        sync: &'a SyncService,
        expiring_sync: &'a SyncService,
        contexts: &'a Arc<ContextStore>,
        workflows: &'a WorkflowService,
        expiring_workflows: &'a WorkflowService,
        search: &'a GlobalSearchService,
        rename: &'a RenameService,
        expiring_rename: &'a RenameService,
        file_locks: &'a FileLockService,
        stream_graph: &'a Arc<StreamGraphService>,
        branch_mappings: &'a Arc<BranchMappingService>,
        stream_switch: &'a Arc<StreamSwitchService>,
        expiring_stream_switch: &'a Arc<StreamSwitchService>,
    }

    async fn exercise_services(
        services: ServiceExercise<'_>,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let ServiceExercise {
            connection,
            runner,
            files,
            changelists,
            journal,
            logs,
            submit,
            expiring_submit,
            sync,
            expiring_sync,
            contexts,
            workflows,
            expiring_workflows,
            search,
            rename,
            expiring_rename,
            file_locks,
            stream_graph,
            branch_mappings,
            stream_switch,
            expiring_stream_switch,
        } = services;
        let status = connection.test_connection(context.clone()).await;
        ensure(
            status.state == ConnectionState::Connected,
            format!("typed connection state was {:?}", status.state),
        )?;

        let ticket = connection.login_status(context.clone()).await;
        ensure(
            ticket.state == ConnectionState::Connected,
            format!("fixture ticket was not valid: {:?}", ticket.state),
        )?;
        let logged_out = connection
            .logout(AuthenticationRequest {
                operation_id: None,
                context: context.clone(),
                confirmed: true,
            })
            .await;
        ensure(
            logged_out.state == ConnectionState::AuthRequired,
            format!("typed logout state was {:?}", logged_out.state),
        )?;
        let missing_ticket = connection.login_status(context.clone()).await;
        ensure(
            missing_ticket.state == ConnectionState::AuthRequired,
            format!(
                "missing fixture ticket was classified as {:?}",
                missing_ticket.state
            ),
        )?;
        let logged_in = connection
            .login(LoginRequest {
                operation_id: None,
                context: context.clone(),
                password: "p4deck-local-only".into(),
                confirmed: true,
            })
            .await;
        ensure(
            logged_in.state == ConnectionState::Connected,
            format!("fixture login failed: {:?}", logged_in.state),
        )?;
        let restored_ticket = connection.login_status(context.clone()).await;
        ensure(
            restored_ticket.state == ConnectionState::Connected,
            format!(
                "restored fixture ticket was classified as {:?}",
                restored_ticket.state
            ),
        )?;

        let info = checked_run(
            runner,
            context,
            "info",
            Vec::new(),
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let server_id = json_values(&info).into_iter().find_map(|value| {
            value
                .get("ServerID")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        ensure(
            server_id.as_deref() == Some(FIXTURE_SERVER_ID),
            format!("unexpected p4d server id: {server_id:?}"),
        )?;

        let listed = workspaces::list(runner, context.clone(), None).await?;
        let listed = serde_json::to_value(listed).map_err(|error| error.to_string())?;
        ensure(
            listed
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["name"] == E2E_CLIENT)),
            "application repository did not list the E2E workspace",
        )?;

        let depots = files.depot_children(context.clone(), None, None).await?;
        ensure(
            depots.iter().any(|node| node.depot_path == "//depot"),
            "Depot browser did not return the depot root",
        )?;
        let depot_root = files
            .depot_children(context.clone(), Some("//depot".into()), None)
            .await?;
        ensure(
            depot_root
                .iter()
                .any(|node| node.depot_path == "//depot/main"),
            "Depot browser did not return //depot/main",
        )?;
        let depot_main = files
            .depot_children(context.clone(), Some("//depot/main".into()), None)
            .await?;
        ensure(
            depot_main
                .iter()
                .any(|node| node.depot_path == "//depot/main/README.txt"),
            "Depot browser did not return the seed README",
        )?;

        let baseline = root.join("main").join("README.txt");
        confirmed_sync(sync, vec!["//depot/main/README.txt".into()], None).await?;
        ensure(
            baseline.is_file(),
            "Sync did not materialize the seed README",
        )?;
        exercise_workspace_status(runner, files, context, root).await?;
        exercise_rename_state_machine(
            rename,
            expiring_rename,
            contexts,
            runner,
            files,
            changelists,
            context,
            root,
        )
        .await?;
        exercise_file_lock_state_machine(
            runner,
            files,
            changelists,
            file_locks,
            contexts,
            context,
            root,
        )
        .await?;
        let main = files
            .workspace_children(
                context.clone(),
                Some(root.join("main").to_string_lossy().into_owned()),
                false,
                None,
            )
            .await?;
        ensure(
            main.items.iter().any(|node| {
                node.name == "README.txt"
                    && node.depot_path.as_deref() == Some("//depot/main/README.txt")
            }),
            format!("Workspace browser did not map the seed README: {main:?}"),
        )?;

        let baseline_path = baseline.to_string_lossy().into_owned();
        action(
            files,
            context,
            FileAction::Checkout,
            vec![baseline_path.clone()],
        )
        .await?;
        ensure_state(files, context, root, "README.txt", "openedEdit").await?;
        action(
            files,
            context,
            FileAction::Revert,
            vec![baseline_path.clone()],
        )
        .await?;
        ensure_state(files, context, root, "README.txt", "controlled").await?;

        exercise_sync_state_machine(
            runner,
            files,
            sync,
            expiring_sync,
            contexts,
            journal,
            context,
            root,
        )
        .await?;

        let added = root.join("main").join("e2e-add.txt");
        std::fs::write(&added, b"P4Deck E2E add\n").map_err(|error| error.to_string())?;
        let added_path = added.to_string_lossy().into_owned();
        action(files, context, FileAction::Add, vec![added_path.clone()]).await?;
        ensure_state(files, context, root, "e2e-add.txt", "openedAdd").await?;
        action(files, context, FileAction::Revert, vec![added_path]).await?;
        std::fs::remove_file(&added).map_err(|error| error.to_string())?;

        action(
            files,
            context,
            FileAction::MarkForDelete,
            vec![baseline_path.clone()],
        )
        .await?;
        let opened_delete = checked_run(
            runner,
            context,
            "opened",
            vec!["//depot/main/README.txt".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        ensure(
            json_values(&opened_delete).into_iter().any(|value| {
                value.get("depotFile").and_then(Value::as_str) == Some("//depot/main/README.txt")
                    && value.get("action").and_then(Value::as_str) == Some("delete")
            }),
            "Delete did not open the seed README for delete",
        )?;
        ensure_state(files, context, root, "README.txt", "openedDelete").await?;
        action(files, context, FileAction::Revert, vec![baseline_path]).await?;
        ensure_state(files, context, root, "README.txt", "controlled").await?;

        let opened = checked_run(
            runner,
            context,
            "opened",
            vec!["//...".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let opened_values = json_values(&opened);
        ensure(
            opened_values
                .iter()
                .all(|value| value.get("depotFile").is_none()),
            format!("E2E client still has opened files after Revert: {opened_values:?}"),
        )?;
        exercise_pending_changelists(
            changelists,
            workflows,
            journal,
            runner,
            files,
            context,
            root,
        )
        .await?;
        exercise_shelf_unshelve_resolve(
            runner,
            files,
            changelists,
            (workflows, expiring_workflows),
            contexts,
            context,
            root,
        )
        .await?;
        exercise_submit_state_machine(
            changelists,
            journal,
            logs,
            submit,
            expiring_submit,
            contexts,
            files,
            context,
            root,
        )
        .await?;
        exercise_submitted_change_details(runner, files, changelists, contexts, context).await?;
        exercise_global_search(runner, changelists, search, contexts, context, root).await?;
        exercise_submit_blockers(runner, changelists, submit, sync, files, context, root).await?;
        exercise_submit_permission_blocker(runner, changelists, context, root).await?;
        exercise_branch_mappings(branch_mappings, runner, contexts, context, root).await?;
        exercise_stream_switch(
            connection,
            runner,
            contexts,
            (stream_graph, stream_switch, expiring_stream_switch),
            context,
            root,
        )
        .await?;
        Ok(())
    }

    async fn exercise_branch_mappings(
        service: &BranchMappingService,
        runner: &P4Runner,
        contexts: &ContextStore,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        const MAP: &str = "p4deck-e2e-map";
        const EXTRA: &str = "p4deck-e2e-map-extra";
        const FOREIGN: &str = "p4deck-e2e-map-foreign";
        const SOURCE: &str = "//depot/p4deck-branch-source/...";
        const TARGET: &str = "//depot/p4deck-branch-target/...";

        for name in [MAP, EXTRA, FOREIGN] {
            let _ = checked_run(
                runner,
                context,
                "branch",
                vec!["-d".into(), name.into()],
                None,
                OutputMode::Text,
            )
            .await;
        }
        for depot in [SOURCE, TARGET] {
            let _ = checked_run(
                runner,
                context,
                "obliterate",
                vec!["-y".into(), depot.into()],
                None,
                OutputMode::Text,
            )
            .await;
        }

        let source_dir = root.join("p4deck-branch-source");
        let target_dir = root.join("p4deck-branch-target");
        let scenario = async {
            std::fs::create_dir_all(&source_dir).map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
            let source_file = source_dir.join("source-only.txt");
            let target_file = target_dir.join("target-only.txt");
            std::fs::write(&source_file, b"branch source fixture\n")
                .map_err(|error| error.to_string())?;
            std::fs::write(&target_file, b"branch target fixture\n")
                .map_err(|error| error.to_string())?;
            checked_run(
                runner,
                context,
                "add",
                vec![
                    source_file.to_string_lossy().into_owned(),
                    target_file.to_string_lossy().into_owned(),
                ],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                context,
                "submit",
                vec!["-d".into(), "P4Deck Branch Mapping fixture".into()],
                None,
                OutputMode::Text,
            )
            .await?;

            let mapping = |description: &str| BranchMappingDraft {
                name: MAP.into(),
                owner: FIXTURE_USER.into(),
                description: description.into(),
                locked: false,
                view: vec![BranchViewLine {
                    modifier: BranchViewModifier::Map,
                    source: Some(SOURCE.into()),
                    target: Some(TARGET.into()),
                    comment: None,
                    unknown: None,
                }],
            };
            let create = service
                .preflight(
                    BranchMutationPreflightRequest {
                        mode: BranchMutationMode::Create,
                        name: MAP.into(),
                        desired: Some(mapping("Branch Mapping fixture Unicode 映射")),
                        operation_id: Some("branch-e2e-create-preflight".into()),
                    },
                    None,
                )
                .await;
            ensure(
                create.ready && create.token.is_some() && create.target.is_some(),
                format!("Branch Mapping create preflight was not ready: {create:?}"),
            )?;
            let create_confirmation = BranchMutationConfirmation {
                token: create.token.clone().expect("checked create token"),
                target: create.target.clone().expect("checked create target"),
                preview_digest: create.preview_digest.clone(),
                acknowledge_dangerous_delete: false,
                operation_id: Some("branch-e2e-create".into()),
            };
            let created = service.confirm(create_confirmation.clone(), None).await;
            ensure(
                created.outcome == BranchMutationOutcome::Succeeded,
                format!("Branch Mapping create did not verify: {created:?}"),
            )?;
            let replay = service.confirm(create_confirmation, None).await;
            ensure(
                replay.failure == Some(BranchMutationFailureCode::TokenUnknown),
                format!("Branch Mapping mutation token was replayable: {replay:?}"),
            )?;

            for (name, owner) in [(EXTRA, FIXTURE_USER), (FOREIGN, READ_ONLY_USER)] {
                let form = format!(
                    "Branch: {name}\n\nOwner: {owner}\n\nDescription:\n\tBranch Mapping pagination fixture.\n\nOptions: unlocked\n\nView:\n\t{SOURCE} {TARGET}\n"
                );
                checked_run(
                    runner,
                    context,
                    "branch",
                    vec!["-i".into()],
                    Some(form),
                    OutputMode::Text,
                )
                .await?;
            }

            let first = service
                .list(
                    BranchMappingQuery {
                        operation_id: "branch-e2e-list-1".into(),
                        request_generation: 81,
                        name_filter: Some("p4deck-e2e-map".into()),
                        owner: None,
                        page_size: 1,
                        cursor: None,
                    },
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            ensure(
                first.items.len() == 1 && first.has_more && first.next_cursor.is_some(),
                format!("Branch Mapping first page was invalid: {first:?}"),
            )?;
            let first_cursor = first.next_cursor.clone().expect("checked list cursor");
            let forged = service
                .list(
                    BranchMappingQuery {
                        operation_id: "branch-e2e-list-forged".into(),
                        request_generation: 81,
                        name_filter: Some("different".into()),
                        owner: None,
                        page_size: 1,
                        cursor: Some(first_cursor.clone()),
                    },
                    None,
                )
                .await
                .expect_err("Branch Mapping cursor accepted a changed query");
            ensure(
                forged.code == BranchMappingRequestErrorCode::InvalidCursor,
                format!("forged Branch Mapping cursor was misclassified: {forged:?}"),
            )?;
            let second = service
                .list(
                    BranchMappingQuery {
                        operation_id: "branch-e2e-list-2".into(),
                        request_generation: 81,
                        name_filter: Some("p4deck-e2e-map".into()),
                        owner: None,
                        page_size: 1,
                        cursor: Some(first_cursor.clone()),
                    },
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            ensure(
                second.items.len() == 1,
                format!("Branch Mapping second page was invalid: {second:?}"),
            )?;
            let replayed_cursor = service
                .list(
                    BranchMappingQuery {
                        operation_id: "branch-e2e-list-replay".into(),
                        request_generation: 81,
                        name_filter: Some("p4deck-e2e-map".into()),
                        owner: None,
                        page_size: 1,
                        cursor: Some(first_cursor),
                    },
                    None,
                )
                .await
                .expect_err("Branch Mapping cursor was replayable");
            ensure(
                matches!(
                    replayed_cursor.code,
                    BranchMappingRequestErrorCode::InvalidCursor
                        | BranchMappingRequestErrorCode::CursorExpired
                ),
                format!("replayed Branch Mapping cursor was misclassified: {replayed_cursor:?}"),
            )?;

            let detail = service
                .detail(
                    BranchMappingDetailQuery {
                        expected_generation: None,
                        operation_id: "branch-e2e-detail".into(),
                        request_generation: 82,
                        name: MAP.into(),
                    },
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            ensure(
                detail.detail.editable
                    && detail.detail.description.contains("Unicode")
                    && detail.detail.view.len() == 1,
                format!("Branch Mapping detail was not structured: {detail:?}"),
            )?;

            let foreign_delete = service
                .preflight(
                    BranchMutationPreflightRequest {
                        mode: BranchMutationMode::Delete,
                        name: FOREIGN.into(),
                        desired: None,
                        operation_id: Some("branch-e2e-foreign-delete".into()),
                    },
                    None,
                )
                .await;
            ensure(
                !foreign_delete.ready
                    && foreign_delete.token.is_none()
                    && foreign_delete
                        .blockers
                        .iter()
                        .any(|issue| issue.code == BranchIssueCode::OwnerMismatch),
                format!("non-owner Branch Mapping delete was not blocked: {foreign_delete:?}"),
            )?;

            let reviewed_edit = service
                .preflight(
                    BranchMutationPreflightRequest {
                        mode: BranchMutationMode::Edit,
                        name: MAP.into(),
                        desired: Some(mapping("reviewed edit")),
                        operation_id: Some("branch-e2e-toctou-preflight".into()),
                    },
                    None,
                )
                .await;
            let concurrent_form = format!(
                "Branch: {MAP}\n\nOwner: {FIXTURE_USER}\n\nDescription:\n\tconcurrent edit\n\nOptions: unlocked\n\nView:\n\t{SOURCE} {TARGET}\n"
            );
            checked_run(
                runner,
                context,
                "branch",
                vec!["-i".into()],
                Some(concurrent_form),
                OutputMode::Text,
            )
            .await?;
            let changed = service
                .confirm(
                    BranchMutationConfirmation {
                        token: reviewed_edit.token.ok_or("TOCTOU preflight had no token")?,
                        target: reviewed_edit.target.ok_or("TOCTOU preflight had no target")?,
                        preview_digest: reviewed_edit.preview_digest,
                        acknowledge_dangerous_delete: false,
                        operation_id: Some("branch-e2e-toctou-confirm".into()),
                    },
                    None,
                )
                .await;
            ensure(
                changed.failure == Some(BranchMutationFailureCode::PreflightChanged),
                format!("Branch Mapping TOCTOU was not rejected: {changed:?}"),
            )?;

            let edit = service
                .preflight(
                    BranchMutationPreflightRequest {
                        mode: BranchMutationMode::Edit,
                        name: MAP.into(),
                        desired: Some(mapping("edited and verified")),
                        operation_id: Some("branch-e2e-edit-preflight".into()),
                    },
                    None,
                )
                .await;
            let edited = service
                .confirm(
                    BranchMutationConfirmation {
                        token: edit.token.ok_or("edit preflight had no token")?,
                        target: edit.target.ok_or("edit preflight had no target")?,
                        preview_digest: edit.preview_digest,
                        acknowledge_dangerous_delete: false,
                        operation_id: Some("branch-e2e-edit".into()),
                    },
                    None,
                )
                .await;
            ensure(
                edited.outcome == BranchMutationOutcome::Succeeded
                    && edited
                        .observed
                        .as_ref()
                        .is_some_and(|value| value.description == "edited and verified"),
                format!("Branch Mapping edit did not verify: {edited:?}"),
            )?;

            let opened_before = checked_run(
                runner,
                context,
                "opened",
                vec!["-C".into(), E2E_CLIENT.into()],
                None,
                OutputMode::JsonLines,
            )
            .await?;
            let source_before = std::fs::read(&source_file).map_err(|error| error.to_string())?;
            let target_before = std::fs::read(&target_file).map_err(|error| error.to_string())?;
            for (direction, operation_id) in [
                (BranchImpactDirection::Forward, "branch-e2e-preview-forward"),
                (BranchImpactDirection::Reverse, "branch-e2e-preview-reverse"),
            ] {
                let preview = service
                    .preview(
                        BranchImpactPreviewQuery {
                            operation_id: operation_id.into(),
                            request_generation: 83,
                            name: MAP.into(),
                            direction,
                            limit: 20,
                        },
                        None,
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                ensure(
                    preview.blockers.is_empty()
                        && !preview.items.is_empty()
                        && preview.items.iter().all(|item| item.action.is_some()),
                    format!("Branch Mapping {direction:?} preview was invalid: {preview:?}"),
                )?;
            }
            let opened_after = checked_run(
                runner,
                context,
                "opened",
                vec!["-C".into(), E2E_CLIENT.into()],
                None,
                OutputMode::JsonLines,
            )
            .await?;
            ensure(
                json_values(&opened_before) == json_values(&opened_after)
                    && std::fs::read(&source_file).map_err(|error| error.to_string())?
                        == source_before
                    && std::fs::read(&target_file).map_err(|error| error.to_string())?
                        == target_before,
                "Branch Mapping preview changed opened files or workspace content",
            )?;

            service.cancel("branch-e2e-cancelled");
            let cancelled = service
                .list(
                    BranchMappingQuery {
                        operation_id: "branch-e2e-cancelled".into(),
                        request_generation: 84,
                        name_filter: Some("p4deck-e2e-map".into()),
                        owner: None,
                        page_size: 10,
                        cursor: None,
                    },
                    None,
                )
                .await
                .expect_err("pre-cancelled Branch Mapping list ran");
            ensure(
                cancelled.code == BranchMappingRequestErrorCode::Cancelled,
                format!("Branch Mapping cancellation was misclassified: {cancelled:?}"),
            )?;

            let delete_without_ack = service
                .preflight(
                    BranchMutationPreflightRequest {
                        mode: BranchMutationMode::Delete,
                        name: MAP.into(),
                        desired: None,
                        operation_id: Some("branch-e2e-delete-preflight-no-ack".into()),
                    },
                    None,
                )
                .await;
            let rejected_delete = service
                .confirm(
                    BranchMutationConfirmation {
                        token: delete_without_ack
                            .token
                            .ok_or("delete preflight had no token")?,
                        target: delete_without_ack
                            .target
                            .ok_or("delete preflight had no target")?,
                        preview_digest: delete_without_ack.preview_digest,
                        acknowledge_dangerous_delete: false,
                        operation_id: Some("branch-e2e-delete-no-ack".into()),
                    },
                    None,
                )
                .await;
            ensure(
                rejected_delete.failure
                    == Some(BranchMutationFailureCode::DangerousConfirmationRequired),
                format!("Branch Mapping delete did not require acknowledgement: {rejected_delete:?}"),
            )?;
            let delete = service
                .preflight(
                    BranchMutationPreflightRequest {
                        mode: BranchMutationMode::Delete,
                        name: MAP.into(),
                        desired: None,
                        operation_id: Some("branch-e2e-delete-preflight".into()),
                    },
                    None,
                )
                .await;
            ensure(
                delete
                    .warnings
                    .iter()
                    .any(|issue| issue.code == BranchIssueCode::DestructiveDelete),
                format!("Branch Mapping delete warning was missing: {delete:?}"),
            )?;
            let deleted = service
                .confirm(
                    BranchMutationConfirmation {
                        token: delete.token.ok_or("delete preflight had no token")?,
                        target: delete.target.ok_or("delete preflight had no target")?,
                        preview_digest: delete.preview_digest,
                        acknowledge_dangerous_delete: true,
                        operation_id: Some("branch-e2e-delete".into()),
                    },
                    None,
                )
                .await;
            ensure(
                deleted.outcome == BranchMutationOutcome::Succeeded
                    && deleted.observed.is_none(),
                format!("Branch Mapping delete did not verify missing: {deleted:?}"),
            )?;

            let generation_page = service
                .list(
                    BranchMappingQuery {
                        operation_id: "branch-e2e-generation-page".into(),
                        request_generation: 85,
                        name_filter: Some("p4deck-e2e-map".into()),
                        owner: None,
                        page_size: 1,
                        cursor: None,
                    },
                    None,
                )
                .await
                .map_err(|error| error.to_string())?;
            let generation = contexts.snapshot().1;
            contexts
                .advance_generation_if_unchanged(generation)
                .map_err(|error| error.to_string())?;
            let stale = service
                .list(
                    BranchMappingQuery {
                        operation_id: "branch-e2e-generation-stale".into(),
                        request_generation: 85,
                        name_filter: Some("p4deck-e2e-map".into()),
                        owner: None,
                        page_size: 1,
                        cursor: generation_page.next_cursor,
                    },
                    None,
                )
                .await
                .expect_err("generation-bound Branch Mapping cursor survived drift");
            ensure(
                matches!(
                    stale.code,
                    BranchMappingRequestErrorCode::InvalidCursor
                        | BranchMappingRequestErrorCode::ConnectionChanged
                ),
                format!("Branch Mapping generation drift was misclassified: {stale:?}"),
            )
        }
        .await;

        for name in [MAP, EXTRA, FOREIGN] {
            let _ = checked_run(
                runner,
                context,
                "branch",
                vec!["-d".into(), name.into()],
                None,
                OutputMode::Text,
            )
            .await;
        }
        for depot in [SOURCE, TARGET] {
            let _ = checked_run(
                runner,
                context,
                "obliterate",
                vec!["-y".into(), depot.into()],
                None,
                OutputMode::Text,
            )
            .await;
        }
        if source_dir.exists() {
            let _ = std::fs::remove_dir_all(&source_dir);
        }
        if target_dir.exists() {
            let _ = std::fs::remove_dir_all(&target_dir);
        }
        scenario
    }

    fn stream_graph_query(
        operation_id: &str,
        request_generation: u64,
        depot_prefix: Option<&str>,
        text: Option<&str>,
        include_deleted: bool,
        page: (usize, Option<String>),
        refresh: bool,
    ) -> StreamGraphQuery {
        let (page_size, cursor) = page;
        StreamGraphQuery {
            operation_id: operation_id.into(),
            request_generation,
            depot_prefix: depot_prefix.map(str::to_owned),
            text: text.map(str::to_owned),
            include_deleted,
            page_size,
            cursor,
            refresh,
        }
    }

    async fn exercise_stream_graph(
        service: &StreamGraphService,
        contexts: &ContextStore,
    ) -> Result<(), String> {
        let generation = contexts.snapshot().1;
        let prefix = format!("//{STREAM_DEPOT}");
        let first_query = stream_graph_query(
            "stream-graph-e2e-page-1",
            71,
            Some(&prefix),
            None,
            false,
            (2, None),
            true,
        );
        let first = service
            .query(first_query.clone(), None)
            .await
            .map_err(|error| format!("Stream Graph first page: {error}"))?;
        ensure(
            first.nodes.len() == 2
                && first.has_more
                && first.next_cursor.is_some()
                && first.cache_freshness == StreamGraphCacheFreshness::Fresh
                && first.scope.context_generation == generation,
            format!("Stream Graph first page was invalid: {first:?}"),
        )?;

        let mut cached_query = first_query.clone();
        cached_query.operation_id = "stream-graph-e2e-cached".into();
        cached_query.refresh = false;
        let cached = service
            .query(cached_query, None)
            .await
            .map_err(|error| format!("Stream Graph cached page: {error}"))?;
        ensure(
            cached.cache_freshness == StreamGraphCacheFreshness::Cached,
            format!("Stream Graph cache freshness was not explicit: {cached:?}"),
        )?;

        let first_cursor = first
            .next_cursor
            .clone()
            .ok_or("Stream Graph first page returned no cursor")?;
        let mut paths = first
            .nodes
            .iter()
            .map(|node| node.stream.clone())
            .collect::<Vec<_>>();
        let mut cursor = Some(first_cursor.clone());
        let mut page = 2u64;
        while let Some(current) = cursor {
            let next = service
                .query(
                    stream_graph_query(
                        &format!("stream-graph-e2e-page-{page}"),
                        71,
                        Some(&prefix),
                        None,
                        false,
                        (2, Some(current)),
                        false,
                    ),
                    None,
                )
                .await
                .map_err(|error| format!("Stream Graph page {page}: {error}"))?;
            paths.extend(next.nodes.iter().map(|node| node.stream.clone()));
            cursor = next.next_cursor;
            page += 1;
        }
        for expected in [
            MAIN_STREAM,
            DEV_STREAM,
            RELEASE_STREAM,
            VIRTUAL_STREAM,
            TASK_STREAM,
        ] {
            ensure(
                paths.iter().any(|path| path == expected),
                format!("Stream Graph pagination omitted {expected}: {paths:?}"),
            )?;
        }
        let replay = service
            .query(
                stream_graph_query(
                    "stream-graph-e2e-replay",
                    71,
                    Some(&prefix),
                    None,
                    false,
                    (2, Some(first_cursor)),
                    false,
                ),
                None,
            )
            .await
            .expect_err("consumed Stream Graph cursor was replayable");
        ensure(
            matches!(
                replay.code,
                StreamGraphRequestErrorCode::InvalidCursor
                    | StreamGraphRequestErrorCode::CursorExpired
            ),
            format!("cursor replay had the wrong error: {replay:?}"),
        )?;

        let orphan = service
            .query(
                stream_graph_query(
                    "stream-graph-e2e-orphan",
                    72,
                    Some(&prefix),
                    Some("orphan-filter-child"),
                    false,
                    (20, None),
                    true,
                ),
                None,
            )
            .await
            .map_err(|error| format!("Stream Graph orphan filter: {error}"))?;
        ensure(
            orphan.nodes.len() == 1
                && orphan.nodes[0].stream == TASK_STREAM
                && orphan.edges.is_empty()
                && orphan.orphans == vec![TASK_STREAM]
                && orphan.partial,
            format!("filtered parent was not represented as an orphan: {orphan:?}"),
        )?;

        let deleted = service
            .query(
                stream_graph_query(
                    "stream-graph-e2e-deleted",
                    73,
                    Some(&prefix),
                    None,
                    true,
                    (20, None),
                    true,
                ),
                None,
            )
            .await
            .map_err(|error| format!("Stream Graph includeDeleted: {error}"))?;
        ensure(
            deleted
                .nodes
                .iter()
                .any(|node| node.stream == DELETED_STREAM && node.deleted == Some(true)),
            format!("includeDeleted did not expose the deleted stream: {deleted:?}"),
        )?;

        let missing_scope = service
            .query(
                stream_graph_query(
                    "stream-graph-e2e-missing-scope",
                    74,
                    Some("//p4deck-stream-e2e/no-such-stream"),
                    None,
                    false,
                    (20, None),
                    true,
                ),
                None,
            )
            .await
            .map_err(|error| format!("Stream Graph missing scope: {error}"))?;
        ensure(
            missing_scope.nodes.is_empty(),
            format!("server no-match fallback escaped the client depot scope: {missing_scope:?}"),
        )?;

        service.cancel("stream-graph-e2e-cancelled");
        let cancelled = service
            .query(
                stream_graph_query(
                    "stream-graph-e2e-cancelled",
                    75,
                    Some(&prefix),
                    None,
                    false,
                    (20, None),
                    true,
                ),
                None,
            )
            .await
            .expect_err("pre-cancelled Stream Graph query ran");
        ensure(
            cancelled.code == StreamGraphRequestErrorCode::Cancelled,
            format!("Stream Graph cancellation was misclassified: {cancelled:?}"),
        )?;

        let generation_page = service
            .query(
                stream_graph_query(
                    "stream-graph-e2e-generation-page",
                    76,
                    Some(&prefix),
                    None,
                    false,
                    (1, None),
                    true,
                ),
                None,
            )
            .await
            .map_err(|error| format!("Stream Graph generation page: {error}"))?;
        contexts
            .advance_generation_if_unchanged(generation)
            .map_err(|error| error.to_string())?;
        let stale = service
            .query(
                stream_graph_query(
                    "stream-graph-e2e-generation-stale",
                    76,
                    Some(&prefix),
                    None,
                    false,
                    (1, generation_page.next_cursor),
                    false,
                ),
                None,
            )
            .await
            .expect_err("generation-bound Stream Graph cursor survived drift");
        ensure(
            matches!(
                stale.code,
                StreamGraphRequestErrorCode::InvalidCursor
                    | StreamGraphRequestErrorCode::ConnectionChanged
            ),
            format!("Stream Graph generation drift was misclassified: {stale:?}"),
        )?;
        Ok(())
    }

    async fn exercise_stream_switch(
        connection: &ConnectionService,
        runner: &Arc<P4Runner>,
        contexts: &ContextStore,
        services: (
            &Arc<StreamGraphService>,
            &Arc<StreamSwitchService>,
            &Arc<StreamSwitchService>,
        ),
        original_context: &P4Context,
        original_root: &Path,
    ) -> Result<(), String> {
        let (stream_graph, service, expiring_service) = services;
        let stream_root = original_root
            .parent()
            .ok_or("fixture workspace has no parent")?
            .join("stream-switch-workspace");
        let stream_context = setup_stream_fixture(runner, original_context, &stream_root).await?;
        let (_, generation) = contexts.snapshot();
        let switched_workspace = connection
            .switch_workspace(
                SwitchWorkspaceRequest {
                    expected_generation: generation,
                    client: STREAM_CLIENT.into(),
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        ensure(
            switched_workspace.context.client == STREAM_CLIENT,
            "stream fixture workspace was not activated",
        )?;
        exercise_stream_graph(stream_graph, contexts).await?;

        let scenario = async {
            let preflight = |target: &str, mode, operation: &str| StreamSwitchPreflightRequest {
                target_stream: target.into(),
                mode,
                operation_id: Some(operation.into()),
            };
            let confirmation = |preview: &crate::domain::StreamSwitchPreflight, operation: &str| {
                Ok::<_, String>(StreamSwitchConfirmation {
                    token: preview
                        .token
                        .clone()
                        .ok_or_else(|| "stream preflight returned no token".to_owned())?,
                    target: preview
                        .target_snapshot
                        .clone()
                        .ok_or_else(|| "stream preflight returned no target".to_owned())?,
                    preview_digest: preview.preview_digest.clone(),
                    acknowledge_warnings: true,
                    operation_id: Some(operation.into()),
                })
            };

            let expiring = expiring_service
                .preflight(
                    preflight(
                        DEV_STREAM,
                        StreamSwitchMode::ViewOnly,
                        "stream-e2e-expiring",
                    ),
                    None,
                )
                .await;
            ensure(
                expiring.ready,
                format!("expiring stream preflight was blocked: {expiring:?}"),
            )?;
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let expired = expiring_service
                .confirm(confirmation(&expiring, "stream-e2e-expired-confirm")?, None)
                .await;
            ensure(
                expired.failure == Some(StreamSwitchFailureCode::TokenExpired),
                format!("expired stream token was not rejected: {expired:?}"),
            )?;

            let bound = service
                .preflight(
                    preflight(DEV_STREAM, StreamSwitchMode::ViewOnly, "stream-e2e-binding"),
                    None,
                )
                .await;
            ensure(
                bound.ready,
                format!("binding stream preflight was blocked: {bound:?}"),
            )?;
            let original_confirmation = confirmation(&bound, "stream-e2e-binding-confirm")?;
            let mut tampered = original_confirmation.clone();
            tampered.target.target_stream = MAIN_STREAM.into();
            let mismatch = service.confirm(tampered, None).await;
            ensure(
                mismatch.failure == Some(StreamSwitchFailureCode::TargetMismatch),
                format!("tampered stream target was not rejected: {mismatch:?}"),
            )?;
            let replay = service.confirm(original_confirmation, None).await;
            ensure(
                replay.failure == Some(StreamSwitchFailureCode::TokenUnknown),
                format!("consumed stream token was replayable: {replay:?}"),
            )?;

            let drift = service
                .preflight(
                    preflight(
                        DEV_STREAM,
                        StreamSwitchMode::ViewOnly,
                        "stream-e2e-generation",
                    ),
                    None,
                )
                .await;
            let drift_generation = drift
                .target_snapshot
                .as_ref()
                .ok_or("generation stream preflight returned no target")?
                .context_generation;
            contexts
                .advance_generation_if_unchanged(drift_generation)
                .map_err(|error| error.to_string())?;
            let drifted = service
                .confirm(confirmation(&drift, "stream-e2e-generation-confirm")?, None)
                .await;
            ensure(
                drifted.failure == Some(StreamSwitchFailureCode::ContextChanged),
                format!("stream generation drift was not rejected: {drifted:?}"),
            )?;

            let changed = service
                .preflight(
                    preflight(DEV_STREAM, StreamSwitchMode::ViewOnly, "stream-e2e-toctou"),
                    None,
                )
                .await;
            ensure(
                changed.ready,
                format!("TOCTOU stream preflight was blocked: {changed:?}"),
            )?;
            let untracked = stream_root.join("untracked-after-preflight.txt");
            std::fs::write(&untracked, b"must survive\n").map_err(|error| error.to_string())?;
            let rejected = service
                .confirm(confirmation(&changed, "stream-e2e-toctou-confirm")?, None)
                .await;
            ensure(
                rejected.failure == Some(StreamSwitchFailureCode::PreflightChanged)
                    || rejected.failure == Some(StreamSwitchFailureCode::PreflightBlocked),
                format!("stream TOCTOU drift was not rejected: {rejected:?}"),
            )?;
            ensure(
                std::fs::read_to_string(&untracked).map_err(|error| error.to_string())?
                    == "must survive\n",
                "TOCTOU rejection modified the untracked file",
            )?;
            std::fs::remove_file(&untracked).map_err(|error| error.to_string())?;

            let fixture_file = stream_root.join("stream-switch.txt");
            checked_run(
                runner,
                &stream_context,
                "edit",
                vec![fixture_file.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            let opened = service
                .preflight(
                    preflight(DEV_STREAM, StreamSwitchMode::ViewOnly, "stream-e2e-opened"),
                    None,
                )
                .await;
            ensure(
                !opened.ready
                    && opened
                        .blockers
                        .iter()
                        .any(|item| item.code == StreamSwitchIssueCode::OpenedFiles),
                format!("opened files did not block stream switch: {opened:?}"),
            )?;
            checked_run(
                runner,
                &stream_context,
                "revert",
                vec![fixture_file.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;

            let view_only = service
                .preflight(
                    preflight(
                        DEV_STREAM,
                        StreamSwitchMode::ViewOnly,
                        "stream-e2e-view-only",
                    ),
                    None,
                )
                .await;
            ensure(
                view_only.ready,
                format!("view-only stream preflight was blocked: {view_only:?}"),
            )?;
            let viewed = service
                .confirm(
                    confirmation(&view_only, "stream-e2e-view-only-confirm")?,
                    None,
                )
                .await;
            ensure(
                viewed.outcome == StreamSwitchOutcome::Succeeded
                    && viewed.stream_changed
                    && !viewed.sync_performed
                    && viewed.verified_stream.as_deref() == Some(DEV_STREAM),
                format!("view-only stream switch failed: {viewed:?}"),
            )?;
            ensure(
                std::fs::read_to_string(&fixture_file)
                    .map_err(|error| error.to_string())?
                    .trim_end()
                    == "main",
                "view-only stream switch unexpectedly changed workspace content",
            )?;

            let recover = service
                .preflight(
                    preflight(DEV_STREAM, StreamSwitchMode::Sync, "stream-e2e-recover"),
                    None,
                )
                .await;
            ensure(
                recover.ready,
                format!("same-stream recovery preflight was blocked: {recover:?}"),
            )?;
            let recovered = service
                .confirm(confirmation(&recover, "stream-e2e-recover-confirm")?, None)
                .await;
            ensure(
                recovered.outcome == StreamSwitchOutcome::Succeeded
                    && !recovered.stream_changed
                    && recovered.sync_performed
                    && recovered.sync_completed
                    && recovered.verified_stream.as_deref() == Some(DEV_STREAM),
                format!("same-stream recovery sync failed: {recovered:?}"),
            )?;
            ensure(
                std::fs::read_to_string(&fixture_file)
                    .map_err(|error| error.to_string())?
                    .trim_end()
                    == "dev",
                "recovery sync did not materialize development content",
            )?;

            let return_main = service
                .preflight(
                    preflight(
                        MAIN_STREAM,
                        StreamSwitchMode::Sync,
                        "stream-e2e-return-main",
                    ),
                    None,
                )
                .await;
            ensure(
                return_main.ready,
                format!("return-to-main preflight was blocked: {return_main:?}"),
            )?;
            let returned = service
                .confirm(
                    confirmation(&return_main, "stream-e2e-return-main-confirm")?,
                    None,
                )
                .await;
            ensure(
                returned.outcome == StreamSwitchOutcome::Succeeded
                    && returned.stream_changed
                    && returned.sync_completed
                    && returned.verified_stream.as_deref() == Some(MAIN_STREAM),
                format!("return-to-main stream switch failed: {returned:?}"),
            )?;
            ensure(
                std::fs::read_to_string(&fixture_file)
                    .map_err(|error| error.to_string())?
                    .trim_end()
                    == "main",
                "return-to-main sync did not restore mainline content",
            )?;
            Ok(())
        }
        .await;

        let (_, generation) = contexts.snapshot();
        let restore = connection
            .switch_workspace(
                SwitchWorkspaceRequest {
                    expected_generation: generation,
                    client: original_context.client.clone(),
                },
                None,
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string());
        match (scenario, restore) {
            (Err(error), Err(restore_error)) => Err(format!(
                "{error}; restoring the original workspace also failed: {restore_error}"
            )),
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(format!("restoring original workspace failed: {error}")),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    async fn exercise_workspace_status(
        runner: &Arc<P4Runner>,
        files: &FileService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let main = root.join("main");
        let baseline = main.join("README.txt");
        let opened_before = checked_run(
            runner,
            context,
            "opened",
            vec!["//depot/main/README.txt".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        ensure(
            json_values(&opened_before)
                .iter()
                .all(|value| value.get("depotFile").is_none()),
            "workspace status fixture started with an opened README",
        )?;

        make_writable(&baseline)?;
        std::fs::write(&baseline, b"workspace modified outside Perforce\n")
            .map_err(|error| error.to_string())?;
        let direct_preview = checked_run(
            runner,
            context,
            "reconcile",
            vec![
                "-n".into(),
                "-e".into(),
                "-a".into(),
                "-d".into(),
                "-f".into(),
                "-l".into(),
                format!("{}/*", main.to_string_lossy().replace('\\', "/")),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        ensure(
            json_values(&direct_preview).iter().any(|value| {
                value.get("action").and_then(Value::as_str) == Some("edit")
                    || value
                        .get("data")
                        .and_then(Value::as_str)
                        .is_some_and(|message| message.contains("opened for edit"))
            }),
            format!(
                "fixture reconcile preview did not see local edit: {}",
                event_text(&direct_preview)
            ),
        )?;
        let modified = files
            .workspace_children(
                context.clone(),
                Some(main.to_string_lossy().into_owned()),
                true,
                None,
            )
            .await?;
        let modified_node = modified
            .items
            .iter()
            .find(|node| node.name == "README.txt")
            .ok_or("modified README was missing from workspace status")?;
        ensure(
            modified_node.state == "modified"
                && modified_node.status.reconcile_action
                    == Some(crate::domain::WorkspaceReconcileAction::Edit)
                && modified_node.status.evidence.iter().any(|item| {
                    item.source == crate::domain::WorkspaceStatusSource::ReconcilePreview
                }),
            format!("workspace modification was not classified: {modified_node:?}"),
        )?;
        let opened_after = checked_run(
            runner,
            context,
            "opened",
            vec!["//depot/main/README.txt".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        ensure(
            json_values(&opened_after)
                .iter()
                .all(|value| value.get("depotFile").is_none()),
            "reconcile preview changed opened state",
        )?;
        checked_run(
            runner,
            context,
            "sync",
            vec!["-f".into(), "//depot/main/README.txt".into()],
            None,
            OutputMode::Text,
        )
        .await?;

        std::fs::remove_file(&baseline).map_err(|error| error.to_string())?;
        let missing = files
            .workspace_children(
                context.clone(),
                Some(main.to_string_lossy().into_owned()),
                true,
                None,
            )
            .await?;
        ensure(
            missing
                .items
                .iter()
                .any(|node| node.name == "README.txt" && node.state == "missing"),
            format!("missing controlled file was not returned: {missing:?}"),
        )?;
        checked_run(
            runner,
            context,
            "sync",
            vec!["-f".into(), "//depot/main/README.txt".into()],
            None,
            OutputMode::Text,
        )
        .await?;

        let old_ignore = std::env::var_os("P4IGNORE");
        std::env::set_var("P4IGNORE", ".p4ignore");
        let ignore_file = root.join(".p4ignore");
        let ignored = main.join("ignored reason 世界.txt");
        let untracked = main.join("untracked space 世界@#%.txt");
        let cache_file = main.join("cache-add.txt");
        let local_scenario = async {
            std::fs::write(&ignore_file, b"ignored*.txt\n").map_err(|error| error.to_string())?;
            std::fs::write(&ignored, b"ignored\n").map_err(|error| error.to_string())?;
            std::fs::write(&untracked, b"untracked\n").map_err(|error| error.to_string())?;
            std::fs::write(&cache_file, b"cache invalidation\n")
                .map_err(|error| error.to_string())?;
            let first = files
                .workspace_children(
                    context.clone(),
                    Some(main.to_string_lossy().into_owned()),
                    true,
                    None,
                )
                .await?;
            let ignored_node = first
                .items
                .iter()
                .find(|node| node.name == "ignored reason 世界.txt")
                .ok_or("ignored Unicode file was absent")?;
            ensure(
                ignored_node.state == "ignored"
                    && ignored_node.status.ignore.as_ref().is_some_and(|item| {
                        item.rule == "ignored*.txt"
                            && item.source.ends_with(".p4ignore")
                            && item.line == Some(1)
                    }),
                format!("ignore reason/source was not preserved: {ignored_node:?}"),
            )?;
            ensure(
                first.items.iter().any(|node| {
                    node.name == "untracked space 世界@#%.txt" && node.state == "untracked"
                }),
                format!("special Unicode add candidate was not classified: {first:?}"),
            )?;
            let cached = files
                .workspace_children(
                    context.clone(),
                    Some(main.to_string_lossy().into_owned()),
                    false,
                    None,
                )
                .await?;
            ensure(
                cached.operation_ids == first.operation_ids,
                "repeated workspace status query did not use the cached aggregate snapshot",
            )?;
            action(
                files,
                context,
                FileAction::Add,
                vec![cache_file.to_string_lossy().into_owned()],
            )
            .await?;
            let invalidated = files
                .workspace_children(
                    context.clone(),
                    Some(main.to_string_lossy().into_owned()),
                    false,
                    None,
                )
                .await?;
            ensure(
                invalidated.operation_ids != first.operation_ids
                    && invalidated
                        .items
                        .iter()
                        .any(|node| node.name == "cache-add.txt" && node.state == "openedAdd"),
                format!("file mutation did not invalidate status cache: {invalidated:?}"),
            )?;
            action(
                files,
                context,
                FileAction::Revert,
                vec![cache_file.to_string_lossy().into_owned()],
            )
            .await
        }
        .await;
        if let Some(value) = old_ignore {
            std::env::set_var("P4IGNORE", value);
        } else {
            std::env::remove_var("P4IGNORE");
        }
        let _ = std::fs::remove_file(&ignored);
        let _ = std::fs::remove_file(&untracked);
        let _ = std::fs::remove_file(&cache_file);
        let _ = std::fs::remove_file(&ignore_file);
        local_scenario?;

        const PARTIAL_CLIENT: &str = "p4deck-fixture-status-partial";
        let partial_root = root
            .parent()
            .ok_or("status fixture root has no parent")?
            .join("status-partial-workspace");
        let partial_dir = partial_root.join("outside-view");
        std::fs::create_dir_all(&partial_dir).map_err(|error| error.to_string())?;
        std::fs::write(partial_dir.join("kept.txt"), b"local evidence\n")
            .map_err(|error| error.to_string())?;
        let spec = format!(
            "Client: {PARTIAL_CLIENT}\nOwner: {FIXTURE_USER}\nRoot: {}\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nLineEnd: local\nView:\n\t//depot/main/... //{PARTIAL_CLIENT}/main/...\n",
            partial_root.to_string_lossy().replace('\\', "/")
        );
        checked_run(
            runner,
            context,
            "client",
            vec!["-i".into()],
            Some(spec),
            OutputMode::Text,
        )
        .await?;
        let mut partial_context = context.clone();
        partial_context.client = PARTIAL_CLIENT.into();
        partial_context.cwd = Some(partial_root.to_string_lossy().into_owned());
        let partial = files
            .workspace_children(
                partial_context,
                Some(partial_dir.to_string_lossy().into_owned()),
                true,
                None,
            )
            .await;
        let cleanup = cleanup_named_client(runner, context, PARTIAL_CLIENT, &partial_root).await;
        let partial = partial?;
        ensure(
            partial.completeness == crate::domain::WorkspaceStatusCompleteness::Partial
                && partial
                    .items
                    .iter()
                    .any(|node| node.name == "kept.txt" && node.state == "unknown")
                && !partial.errors.is_empty(),
            format!("partial status did not preserve local evidence: {partial:?}"),
        )?;
        cleanup?;
        Ok(())
    }

    async fn exercise_pending_changelists(
        changelists: &ChangelistService,
        workflows: &WorkflowService,
        journal: &OperationJournal,
        runner: &P4Runner,
        files: &FileService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let baseline = root.join("main").join("README.txt");
        let baseline_path = baseline.to_string_lossy().into_owned();
        action(
            files,
            context,
            FileAction::Checkout,
            vec![baseline_path.clone()],
        )
        .await?;
        let added = root.join("main").join("pending-e2e.txt");
        std::fs::write(&added, b"P4Deck pending E2E\n").map_err(|error| error.to_string())?;
        action(
            files,
            context,
            FileAction::Add,
            vec![added.to_string_lossy().into_owned()],
        )
        .await?;

        let initial = changelists.query_pending(context.clone(), None).await?;
        let default = pending_change(&initial, 0)?;
        ensure(
            default
                .files
                .iter()
                .any(|file| file.depot_path == "//depot/main/README.txt"),
            "Default changelist omitted the opened seed file",
        )?;
        ensure(
            default
                .files
                .iter()
                .any(|file| file.depot_path == "//depot/main/pending-e2e.txt"),
            "Default changelist omitted the opened add",
        )?;

        let job_spec = format!(
            "Job: {E2E_JOB}\nStatus: open\nUser: {FIXTURE_USER}\nDescription:\n\tP4Deck E2E job\n"
        );
        checked_run(
            runner,
            context,
            "job",
            vec!["-i".into()],
            Some(job_spec),
            OutputMode::Text,
        )
        .await?;

        let description = "Line one: [#&]\nJobs:\nChange: remains description";
        let created = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-create".into()),
                    mutation: PendingChangeMutation::Create {
                        description: description.into(),
                        jobs: vec![E2E_JOB.into()],
                    },
                },
                None,
            )
            .await?;
        ensure(
            created.operation.operation_id == "be004-create",
            "create did not preserve the supplied operation ID",
        )?;
        ensure(
            journal
                .get("be004-create")
                .is_some_and(|record| record.state == JournalState::Succeeded),
            "successful mutation was not recorded in the Journal",
        )?;
        let change_id = created
            .created_change_id
            .ok_or("create did not return the numbered changelist")?;
        let created_change = pending_change(&created.refreshed_changes, change_id)?;
        ensure(
            created_change.description == description,
            format!(
                "multiline/special description changed: {:?}",
                created_change.description
            ),
        )?;
        ensure(
            created_change.jobs == [E2E_JOB],
            format!("created jobs were {:?}", created_change.jobs),
        )?;

        let paging_extra = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-paging-create".into()),
                    mutation: PendingChangeMutation::Create {
                        description: "pending paging stability fixture".into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?
            .created_change_id
            .ok_or("paging fixture changelist was not created")?;
        let first_page = changelists
            .query_pending_page(
                context.clone(),
                PendingChangeQuery {
                    operation_id: "be004-page-1".into(),
                    request_generation: 41,
                    keyword: String::new(),
                    sort: PendingChangeSort::Newest,
                    page_size: 1,
                    cursor: None,
                },
                None,
            )
            .await?;
        let cursor = first_page
            .next_cursor
            .clone()
            .ok_or("pending first page did not return a continuation cursor")?;
        ensure(
            first_page
                .default_change
                .as_ref()
                .is_some_and(|change| change.id == 0)
                && first_page.items.len() == 1,
            format!("pending first page shape was invalid: {first_page:?}"),
        )?;
        let second_page = changelists
            .query_pending_page(
                context.clone(),
                PendingChangeQuery {
                    operation_id: "be004-page-2".into(),
                    request_generation: 42,
                    keyword: String::new(),
                    sort: PendingChangeSort::Newest,
                    page_size: 1,
                    cursor: Some(cursor.clone()),
                },
                None,
            )
            .await?;
        ensure(
            second_page.default_change.is_none()
                && second_page.items.len() == 1
                && second_page.items[0].id != first_page.items[0].id,
            format!("pending continuation duplicated or forged Default: {second_page:?}"),
        )?;
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-paging-delete".into()),
                    mutation: PendingChangeMutation::Delete {
                        change_id: paging_extra,
                    },
                },
                None,
            )
            .await?;
        ensure(
            changelists
                .query_pending_page(
                    context.clone(),
                    PendingChangeQuery {
                        operation_id: "be004-page-stale".into(),
                        request_generation: 43,
                        keyword: String::new(),
                        sort: PendingChangeSort::Newest,
                        page_size: 1,
                        cursor: Some(cursor),
                    },
                    None,
                )
                .await
                .is_err(),
            "pending cursor survived a create/delete generation change",
        )?;

        let move_numbered = workflows
            .preflight_move(
                MoveFilesPreflightRequest {
                    target_change_id: change_id,
                    depot_paths: vec!["//depot/main/README.txt".into()],
                    operation_id: Some("be004-move-numbered-preflight".into()),
                },
                None,
            )
            .await;
        ensure(
            move_numbered.ready,
            format!("typed move preflight was blocked: {move_numbered:?}"),
        )?;
        let moved = workflows
            .confirm_move(
                WorkflowConfirmation {
                    token: move_numbered
                        .token
                        .ok_or("move preflight returned no token")?,
                    target: move_numbered.target,
                    operation_id: Some("be004-move-numbered".into()),
                },
                None,
            )
            .await;
        ensure(
            moved.outcome == WorkflowOutcome::Succeeded,
            format!("typed move failed: {moved:?}"),
        )?;
        ensure(
            pending_change(&moved.refreshed_changes, change_id)?
                .files
                .iter()
                .any(|file| file.depot_path == "//depot/main/README.txt"),
            "numbered changelist did not receive the moved file",
        )?;
        ensure(
            journal
                .get("be004-move-numbered:1")
                .is_some_and(|record| record.state == JournalState::Succeeded),
            "typed move did not record its per-file reopen in the Journal",
        )?;

        checked_run(
            runner,
            context,
            "shelve",
            vec![
                "-c".into(),
                change_id.to_string(),
                "//depot/main/README.txt".into(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        let with_shelf = changelists.query_pending(context.clone(), None).await?;
        let numbered = pending_change(&with_shelf, change_id)?;
        ensure(
            numbered
                .shelved_files
                .iter()
                .any(|file| file.depot_path == "//depot/main/README.txt"),
            "shelved file was absent from the structured pending query",
        )?;
        ensure(
            numbered
                .shelved_files
                .iter()
                .all(|file| file.state.is_none()),
            "shelved files must not forge a workspace state",
        )?;

        let failed_operation_id = "be004-failed-edit";
        let failed = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some(failed_operation_id.into()),
                    mutation: PendingChangeMutation::Edit {
                        change_id,
                        description: "must not persist".into(),
                        jobs: vec!["P4DECK-NO-SUCH-JOB".into()],
                    },
                },
                None,
            )
            .await;
        ensure(
            failed.is_err(),
            "editing with a missing Job unexpectedly succeeded",
        )?;
        ensure(
            journal.get(failed_operation_id).is_none(),
            "Job preflight rejection unexpectedly entered the mutation Journal",
        )?;
        ensure(
            pending_change(
                &changelists.query_pending(context.clone(), None).await?,
                change_id,
            )?
            .description
                == description,
            "failed edit changed the changelist description",
        )?;

        let edited_description = "Edited line one\nFiles:\n\tstill description";
        let edited = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-edit".into()),
                    mutation: PendingChangeMutation::Edit {
                        change_id,
                        description: edited_description.into(),
                        jobs: vec![E2E_JOB.into()],
                    },
                },
                None,
            )
            .await?;
        ensure(
            pending_change(&edited.refreshed_changes, change_id)?.description == edited_description,
            "edited multiline description was not preserved",
        )?;

        let delete_non_empty = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-delete-non-empty".into()),
                    mutation: PendingChangeMutation::Delete { change_id },
                },
                None,
            )
            .await;
        ensure(
            delete_non_empty.is_err(),
            "non-empty/shelved changelist deletion unexpectedly succeeded",
        )?;

        let move_default = workflows
            .preflight_move(
                MoveFilesPreflightRequest {
                    target_change_id: 0,
                    depot_paths: vec!["//depot/main/README.txt".into()],
                    operation_id: Some("be004-move-default-preflight".into()),
                },
                None,
            )
            .await;
        ensure(
            move_default.ready,
            format!("Default move preflight was blocked: {move_default:?}"),
        )?;
        let moved_default = workflows
            .confirm_move(
                WorkflowConfirmation {
                    token: move_default.token.ok_or("Default move returned no token")?,
                    target: move_default.target,
                    operation_id: Some("be004-move-default".into()),
                },
                None,
            )
            .await;
        ensure(
            moved_default.outcome == WorkflowOutcome::Succeeded,
            format!("Default typed move failed: {moved_default:?}"),
        )?;
        ensure(
            pending_change(&moved_default.refreshed_changes, 0)?
                .files
                .iter()
                .any(|file| file.depot_path == "//depot/main/README.txt"),
            "Default changelist did not receive the moved-back file",
        )?;
        checked_run(
            runner,
            context,
            "shelve",
            vec!["-d".into(), "-c".into(), change_id.to_string()],
            None,
            OutputMode::Text,
        )
        .await?;
        let cleared = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-clear-jobs".into()),
                    mutation: PendingChangeMutation::Edit {
                        change_id,
                        description: edited_description.into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?;
        ensure(
            pending_change(&cleared.refreshed_changes, change_id)?
                .jobs
                .is_empty(),
            "editing the changelist did not clear Jobs",
        )?;
        let deleted = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-delete".into()),
                    mutation: PendingChangeMutation::Delete { change_id },
                },
                None,
            )
            .await?;
        ensure(
            deleted
                .refreshed_changes
                .iter()
                .all(|change| change.id != change_id),
            "deleted changelist was returned by the targeted refresh",
        )?;

        action(files, context, FileAction::Revert, vec![baseline_path]).await?;
        action(
            files,
            context,
            FileAction::Revert,
            vec![added.to_string_lossy().into_owned()],
        )
        .await?;
        if added.exists() {
            std::fs::remove_file(&added).map_err(|error| error.to_string())?;
        }
        checked_run(
            runner,
            context,
            "job",
            vec!["-d".into(), E2E_JOB.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        let final_pending = changelists.query_pending(context.clone(), None).await?;
        ensure(
            final_pending.len() == 1
                && final_pending[0].id == 0
                && final_pending[0].files.is_empty(),
            format!("pending E2E cleanup left state behind: {final_pending:?}"),
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn exercise_submit_state_machine(
        changelists: &ChangelistService,
        journal: &OperationJournal,
        logs: &LogStore,
        submit: &SubmitService,
        expiring_submit: &SubmitService,
        contexts: &ContextStore,
        files: &FileService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let default = submit
            .preflight(SubmitPreflightRequest { change_id: 0 }, None)
            .await;
        ensure(
            has_blocker(&default, crate::domain::SubmitIssueCode::InvalidTarget)
                && has_blocker(&default, crate::domain::SubmitIssueCode::EmptyDescription)
                && has_blocker(&default, crate::domain::SubmitIssueCode::EmptyChange),
            format!("Default CL did not expose empty/invalid blockers: {default:?}"),
        )?;

        let empty = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be003-create-empty".into()),
                    mutation: PendingChangeMutation::Create {
                        description: "BE-003 empty CL".into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?;
        let empty_id = empty.created_change_id.ok_or("empty CL was not created")?;
        let empty_preflight = submit
            .preflight(
                SubmitPreflightRequest {
                    change_id: empty_id,
                },
                None,
            )
            .await;
        ensure(
            has_blocker(
                &empty_preflight,
                crate::domain::SubmitIssueCode::EmptyChange,
            ) && empty_preflight.token.is_none(),
            format!("empty CL unexpectedly passed: {empty_preflight:?}"),
        )?;
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be003-delete-empty".into()),
                    mutation: PendingChangeMutation::Delete {
                        change_id: empty_id,
                    },
                },
                None,
            )
            .await?;

        let local = root.join("p4deck-submit-e2e").join("success.txt");
        std::fs::create_dir_all(local.parent().expect("test file has a parent"))
            .map_err(|error| error.to_string())?;
        std::fs::write(&local, b"BE-003 submit state machine\n")
            .map_err(|error| error.to_string())?;
        action(
            files,
            context,
            FileAction::Add,
            vec![local.to_string_lossy().into_owned()],
        )
        .await?;
        let created = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be003-create-submit".into()),
                    mutation: PendingChangeMutation::Create {
                        description: "BE-003 safe submit".into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?;
        let change_id = created
            .created_change_id
            .ok_or("submit CL was not created")?;
        let depot_path = "//depot/p4deck-submit-e2e/success.txt".to_owned();
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be003-move-submit".into()),
                    mutation: PendingChangeMutation::MoveFiles {
                        target_change_id: change_id,
                        depot_paths: vec![depot_path.clone()],
                    },
                },
                None,
            )
            .await?;

        let expiring = expiring_submit
            .preflight(SubmitPreflightRequest { change_id }, None)
            .await;
        ensure(
            expiring.ready && expiring.token.is_some(),
            format!("expiring preflight was not ready: {expiring:?}"),
        )?;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let expired = expiring_submit
            .confirm(
                SubmitConfirmation {
                    token: expiring.token.expect("checked above"),
                    target: expiring.target,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            expired.failure == Some(SubmitFailureCode::TokenExpired),
            format!("expired token was not rejected: {expired:?}"),
        )?;

        let switched = submit
            .preflight(SubmitPreflightRequest { change_id }, None)
            .await;
        let mut other_workspace = context.clone();
        other_workspace.client = "p4deck-fixture-other-workspace".into();
        other_workspace.cwd = Some(root.join("other-workspace").to_string_lossy().into_owned());
        contexts
            .save(other_workspace)
            .map_err(|error| error.to_string())?;
        let switched_result = submit
            .confirm(
                SubmitConfirmation {
                    token: switched.token.ok_or("workspace preflight had no token")?,
                    target: switched.target,
                    operation_id: None,
                },
                None,
            )
            .await;
        contexts
            .save(context.clone())
            .map_err(|error| error.to_string())?;
        ensure(
            switched_result.failure == Some(SubmitFailureCode::ContextChanged),
            format!("workspace switch was not rejected: {switched_result:?}"),
        )?;

        let mismatched = submit
            .preflight(SubmitPreflightRequest { change_id }, None)
            .await;
        let mut wrong_target = mismatched.target.clone();
        wrong_target.workspace.push_str("-wrong");
        let mismatch_result = submit
            .confirm(
                SubmitConfirmation {
                    token: mismatched.token.ok_or("target preflight had no token")?,
                    target: wrong_target,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            mismatch_result.failure == Some(SubmitFailureCode::TargetMismatch),
            format!("target mismatch was not rejected: {mismatch_result:?}"),
        )?;

        let changed = submit
            .preflight(SubmitPreflightRequest { change_id }, None)
            .await;
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be003-change-after-check".into()),
                    mutation: PendingChangeMutation::Edit {
                        change_id,
                        description: "BE-003 changed after preflight".into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?;
        let changed_result = submit
            .confirm(
                SubmitConfirmation {
                    token: changed.token.ok_or("content preflight had no token")?,
                    target: changed.target,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            matches!(
                changed_result.failure,
                Some(SubmitFailureCode::ChangeChanged | SubmitFailureCode::PreflightBlocked)
            ),
            format!("changed CL was not rejected: {changed_result:?}"),
        )?;
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be003-restore-file-after-change".into()),
                    mutation: PendingChangeMutation::MoveFiles {
                        target_change_id: change_id,
                        depot_paths: vec![depot_path.clone()],
                    },
                },
                None,
            )
            .await?;

        let ready = submit
            .preflight(SubmitPreflightRequest { change_id }, None)
            .await;
        ensure(
            ready.ready && ready.blockers.is_empty() && ready.token.is_some(),
            format!("valid submit preflight was blocked: {ready:?}"),
        )?;
        let submitted = submit
            .confirm(
                SubmitConfirmation {
                    token: ready.token.expect("checked above"),
                    target: ready.target,
                    operation_id: Some("be003-submit-success".into()),
                },
                None,
            )
            .await;
        ensure(
            submitted.outcome == SubmitOutcome::Submitted
                && submitted.submitted_change_id == Some(change_id)
                && submitted.operation_id.as_deref() == Some("be003-submit-success")
                && submitted.log_reference.as_deref() == Some("be003-submit-success"),
            format!("submit did not return a structured success: {submitted:?}"),
        )?;
        ensure(
            journal
                .get("be003-submit-success")
                .is_some_and(|record| record.state == JournalState::Succeeded),
            "successful submit was not recorded in the Operation Journal",
        )?;
        ensure(
            !logs
                .query(&crate::domain::LogQuery {
                    operation_id: Some("be003-submit-success".into()),
                    ..Default::default()
                })
                .is_empty(),
            "successful submit was not linked to a redacted log entry",
        )?;
        ensure(
            changelists
                .query_pending(context.clone(), None)
                .await?
                .iter()
                .all(|change| change.id != change_id),
            "submitted changelist remained pending",
        )
    }

    fn has_blocker(
        preflight: &crate::domain::SubmitPreflight,
        code: crate::domain::SubmitIssueCode,
    ) -> bool {
        preflight.blockers.iter().any(|issue| issue.code == code)
    }

    async fn exercise_submitted_change_details(
        runner: &Arc<P4Runner>,
        files: &FileService,
        changelists: &ChangelistService,
        contexts: &ContextStore,
        context: &P4Context,
    ) -> Result<(), String> {
        let ordinary_id =
            latest_change_id(runner, context, "//depot/p4deck-submit-e2e/success.txt").await?;
        let ordinary = changelists
            .submitted_detail(
                crate::domain::SubmittedChangeDetailRequest {
                    expected_generation: None,
                    refresh: false,
                    change_id: ordinary_id,
                    operation_id: "be008-ordinary-detail".into(),
                },
                None,
            )
            .await;
        ensure(
            ordinary.merge_classification == crate::domain::MergeClassification::Normal
                && ordinary.inspection_status == crate::domain::SubmittedInspectionStatus::Complete
                && ordinary.files.iter().any(|file| {
                    file.depot_path == "//depot/p4deck-submit-e2e/success.txt"
                        && file.revision.is_some()
                }),
            format!("ordinary submitted detail was not verified: {ordinary:?}"),
        )?;

        let branch_path = "//depot/p4deck-submit-e2e/promoted/success.txt";
        checked_run(
            runner,
            context,
            "integrate",
            vec![
                "//depot/p4deck-submit-e2e/success.txt".into(),
                branch_path.into(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;

        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "BE-008 promotion".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let branch_id = latest_change_id(runner, context, branch_path).await?;
        let integrated = changelists
            .submitted_detail(
                crate::domain::SubmittedChangeDetailRequest {
                    expected_generation: None,
                    refresh: false,
                    change_id: branch_id,
                    operation_id: "be008-integrated-detail".into(),
                },
                None,
            )
            .await;
        ensure(
            integrated.merge_classification == crate::domain::MergeClassification::ReliableMerge
                && !integrated.integration_evidence.is_empty()
                && integrated
                    .files
                    .iter()
                    .any(|file| matches!(file.action.as_str(), "branch" | "integrate")),
            format!("real branch submission lacked reliable evidence: {integrated:?}"),
        )?;
        let branch_local = PathBuf::from(context.cwd.as_deref().ok_or("fixture cwd is missing")?)
            .join("p4deck-submit-e2e")
            .join("promoted")
            .join("success.txt");
        checked_run(
            runner,
            context,
            "edit",
            vec![branch_local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let branch_content = std::fs::read(&branch_local).map_err(|error| error.to_string())?;
        let mut divergent = b"graph target divergence\n".to_vec();
        divergent.extend(branch_content);
        std::fs::write(&branch_local, divergent).map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "Revision graph target divergence".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let query = |hide_reliable_merges| crate::domain::ClQuery {
            operation_id: format!("be008-submitted-query-{hide_reliable_merges}"),
            request_generation: 8,
            keyword: String::new(),
            users: Vec::new(),
            clients: Vec::new(),
            depot_path: Some("//depot/p4deck-submit-e2e/...".into()),
            stream: None,
            streams: Vec::new(),
            from: "2000-01-01T00:00:00Z".into(),
            to: "2100-01-01T00:00:00Z".into(),
            jobs: Vec::new(),
            has_job: None,
            merge_classifications: Vec::new(),
            hide_reliable_merges,
            page_size: 100,
            cursor: None,
        };
        let upgraded = changelists
            .query(context.clone(), query(false), None)
            .await?;
        ensure(
            upgraded.items.iter().any(|change| {
                change.id == branch_id
                    && change.merge_classification
                        == crate::domain::MergeClassification::ReliableMerge
            }),
            format!("cached detail did not upgrade the summary: {upgraded:?}"),
        )?;
        let hidden = changelists
            .query(context.clone(), query(true), None)
            .await?;
        ensure(
            hidden.stats.hidden_reliable_merge_count >= 1
                && hidden.items.iter().all(|change| change.id != branch_id),
            format!("reliably classified branch was not hidden: {hidden:?}"),
        )?;

        let mut first_page_query = query(false);
        first_page_query.operation_id = "be009-page-1".into();
        first_page_query.request_generation = 90;
        first_page_query.page_size = 1;
        let first_page = changelists
            .query(context.clone(), first_page_query.clone(), None)
            .await?;
        ensure(
            first_page.items.len() == 1 && first_page.has_more && first_page.next_cursor.is_some(),
            format!("first submitted page was not cursor-paginated: {first_page:?}"),
        )?;
        let first_id = first_page.items[0].id;

        let local = PathBuf::from(context.cwd.as_deref().ok_or("fixture cwd is missing")?)
            .join("p4deck-submit-e2e")
            .join("success.txt");
        checked_run(
            runner,
            context,
            "edit",
            vec![local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&local)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, b"BE-009 stable cursor insertion\n")
            })
            .map_err(|error| error.to_string())?;
        let job_spec = format!(
            "Job: {E2E_JOB}\nStatus: open\nUser: {FIXTURE_USER}\nDescription:\n\tP4Deck submitted query E2E job\n"
        );
        checked_run(
            runner,
            context,
            "job",
            vec!["-i".into()],
            Some(job_spec),
            OutputMode::Text,
        )
        .await?;
        let created = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be009-create-job-submit".into()),
                    mutation: PendingChangeMutation::Create {
                        description: "BE-009 indexed job combined query".into(),
                        jobs: vec![E2E_JOB.into()],
                    },
                },
                None,
            )
            .await?;
        let inserted_id = created
            .created_change_id
            .ok_or("BE-009 job changelist was not created")?;
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be009-move-job-submit".into()),
                    mutation: PendingChangeMutation::MoveFiles {
                        target_change_id: inserted_id,
                        depot_paths: vec!["//depot/p4deck-submit-e2e/success.txt".into()],
                    },
                },
                None,
            )
            .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-c".into(), inserted_id.to_string()],
            None,
            OutputMode::JsonLines,
        )
        .await?;

        checked_run(
            runner,
            context,
            "integrate",
            vec![
                "//depot/p4deck-submit-e2e/success.txt".into(),
                branch_path.into(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "resolve",
            vec!["-am".into(), branch_path.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "Revision graph merge fixture".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let source_local = PathBuf::from(context.cwd.as_deref().ok_or("fixture cwd is missing")?)
            .join("p4deck-submit-e2e")
            .join("success.txt");
        checked_run(
            runner,
            context,
            "edit",
            vec![source_local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&source_local)
            .and_then(|mut file| std::io::Write::write_all(&mut file, b"graph copy source\n"))
            .map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "Revision graph copy source".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "copy",
            vec![
                "-f".into(),
                "//depot/p4deck-submit-e2e/success.txt".into(),
                branch_path.into(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "Revision graph copy fixture".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let moved_path = "//depot/p4deck-submit-e2e/promoted/success-moved.txt";
        checked_run(
            runner,
            context,
            "edit",
            vec![branch_path.into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "move",
            vec![branch_path.into(), moved_path.into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "Revision graph move fixture".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;

        let review_dir = PathBuf::from(context.cwd.as_deref().ok_or("fixture cwd is missing")?)
            .join("p4deck-submit-e2e")
            .join("review");
        std::fs::create_dir_all(&review_dir).map_err(|error| error.to_string())?;
        let special_local = review_dir.join("世界 @#%.txt");
        let special_filespec = special_local
            .to_string_lossy()
            .replace('%', "%25")
            .replace('@', "%40")
            .replace('#', "%23");
        let empty_local = review_dir.join("empty.txt");
        let binary_local = review_dir.join("binary.bin");
        let large_local = review_dir.join("large.txt");
        let special_baseline = "special baseline\n// 世界\nunchanged\n";
        std::fs::write(&special_local, special_baseline).map_err(|error| error.to_string())?;
        std::fs::write(&empty_local, b"").map_err(|error| error.to_string())?;
        std::fs::write(&binary_local, [0_u8, 1, 2, 3, 0xff]).map_err(|error| error.to_string())?;
        std::fs::write(&large_local, vec![b'x'; 4 * 1024 * 1024 + 1])
            .map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "add",
            vec!["-f".into(), special_local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "add",
            vec![empty_local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "add",
            vec![
                "-t".into(),
                "binary".into(),
                binary_local.to_string_lossy().into_owned(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "add",
            vec![
                "-t".into(),
                "text".into(),
                large_local.to_string_lossy().into_owned(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "File review edge-case fixtures".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;

        let (active_context, generation) = contexts.snapshot();
        let review_scope = |file_identity: &str| crate::domain::FileReviewScope {
            server: active_context.server.clone(),
            user: active_context.user.clone(),
            client: active_context.client.clone(),
            workspace: active_context.cwd.clone().unwrap_or_default(),
            active_profile_id: contexts.active_profile_id(),
            context_generation: generation,
            file_identity: file_identity.into(),
        };
        let history = files
            .history(
                crate::domain::FileHistoryRequest {
                    scope: review_scope("//depot/p4deck-submit-e2e/success.txt"),
                    page_size: 1,
                    cursor: None,
                    refresh: false,
                    operation_id: Some("review-history-page-1".into()),
                },
                None,
            )
            .await?;
        ensure(
            history.items.len() == 1 && history.has_more && history.next_cursor.is_some(),
            format!("review history was not stably paginated: {history:?}"),
        )?;
        let second_history = files
            .history(
                crate::domain::FileHistoryRequest {
                    scope: review_scope("//depot/p4deck-submit-e2e/success.txt"),
                    page_size: 1,
                    cursor: history.next_cursor.clone(),
                    refresh: false,
                    operation_id: Some("review-history-page-2".into()),
                },
                None,
            )
            .await?;
        ensure(
            second_history
                .items
                .first()
                .is_some_and(|item| item.revision < history.items[0].revision),
            format!("review history repeated or reordered a page: {second_history:?}"),
        )?;
        let depot_diff = files
            .diff(
                crate::domain::DiffRequest {
                    right_file_identity: None,
                    scope: review_scope("//depot/p4deck-submit-e2e/success.txt"),
                    left: crate::domain::RevisionReference::Revision { revision: 1 },
                    right: crate::domain::RevisionReference::Head,
                    refresh: false,
                    operation_id: Some("review-revision-diff".into()),
                },
                None,
            )
            .await?;
        ensure(
            !depot_diff.binary && !depot_diff.unsupported && !depot_diff.identical,
            format!("revision-to-revision diff did not use real text: {depot_diff:?}"),
        )?;
        let special_depot = "//depot/p4deck-submit-e2e/review/世界 @#%.txt";
        let special_history = files
            .history(
                crate::domain::FileHistoryRequest {
                    scope: review_scope(special_depot),
                    page_size: 10,
                    cursor: None,
                    refresh: false,
                    operation_id: Some("review-special-history".into()),
                },
                None,
            )
            .await?;
        ensure(
            special_history.items.len() == 1,
            format!("special filespec history failed: {special_history:?}"),
        )?;
        make_writable(&special_local)?;
        for (index, (contents, additions, deletions)) in [
            (special_baseline, 0, 0),
            ("special baseline\r\n// 世界\r\nunchanged\r\n", 0, 0),
            ("special baseline\r\n// 世界\nunchanged\r\n", 0, 0),
            ("special edited\r\n// 世界\r\nunchanged\r\n", 1, 1),
            ("special baseline\r\n// 世界\r\nunchanged", 1, 1),
        ]
        .into_iter()
        .enumerate()
        {
            std::fs::write(&special_local, contents).map_err(|error| error.to_string())?;
            let diff = files
                .diff(
                    crate::domain::DiffRequest {
                        right_file_identity: None,
                        scope: review_scope(special_depot),
                        left: crate::domain::RevisionReference::Have,
                        right: crate::domain::RevisionReference::Workspace,
                        refresh: true,
                        operation_id: Some(format!("review-line-endings-{index}")),
                    },
                    None,
                )
                .await?;
            ensure(
                diff.stats.additions == additions
                    && diff.stats.deletions == deletions
                    && diff.identical == (additions == 0 && deletions == 0)
                    && diff.unified.is_empty() == diff.identical,
                format!("CRLF/LF comparison created false changes in case {index}: {diff:?}"),
            )?;
            ensure(
                diff.left_text.as_deref() == Some(special_baseline)
                    && diff.right_text.as_deref() == Some(contents),
                format!("complete diff sources were missing or changed in case {index}"),
            )?;
            if !contents.ends_with('\n') {
                ensure(
                    diff.unified.contains("\\ No newline at end of file"),
                    "workspace EOF newline difference was lost by P4 print",
                )?;
            }
        }
        std::fs::write(&special_local, special_baseline).map_err(|error| error.to_string())?;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&special_local)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, "workspace 世界\n".as_bytes())
            })
            .map_err(|error| error.to_string())?;
        let workspace_diff = files
            .diff(
                crate::domain::DiffRequest {
                    right_file_identity: None,
                    scope: review_scope(special_depot),
                    left: crate::domain::RevisionReference::Have,
                    right: crate::domain::RevisionReference::Workspace,
                    refresh: true,
                    operation_id: Some("review-have-workspace".into()),
                },
                None,
            )
            .await?;
        ensure(
            workspace_diff.stats.additions > 0 && !workspace_diff.identical,
            format!("Have-to-Workspace diff missed text additions: {workspace_diff:?}"),
        )?;
        let have_head = files
            .diff(
                crate::domain::DiffRequest {
                    right_file_identity: None,
                    scope: review_scope(special_depot),
                    left: crate::domain::RevisionReference::Have,
                    right: crate::domain::RevisionReference::Head,
                    refresh: true,
                    operation_id: Some("review-have-head".into()),
                },
                None,
            )
            .await?;
        ensure(
            have_head.identical,
            format!("Have-to-Head identical state was not detected: {have_head:?}"),
        )?;
        checked_run(
            runner,
            context,
            "sync",
            vec!["-f".into(), special_filespec.clone()],
            None,
            OutputMode::Text,
        )
        .await?;
        let empty_diff = files
            .diff(
                crate::domain::DiffRequest {
                    right_file_identity: None,
                    scope: review_scope("//depot/p4deck-submit-e2e/review/empty.txt"),
                    left: crate::domain::RevisionReference::Have,
                    right: crate::domain::RevisionReference::Workspace,
                    refresh: true,
                    operation_id: Some("review-empty".into()),
                },
                None,
            )
            .await?;
        ensure(
            empty_diff.identical && empty_diff.unified.is_empty(),
            "empty file diff was not identical",
        )?;
        let binary_diff = files
            .diff(
                crate::domain::DiffRequest {
                    right_file_identity: None,
                    scope: review_scope("//depot/p4deck-submit-e2e/review/binary.bin"),
                    left: crate::domain::RevisionReference::Have,
                    right: crate::domain::RevisionReference::Head,
                    refresh: true,
                    operation_id: Some("review-binary".into()),
                },
                None,
            )
            .await?;
        ensure(
            binary_diff.binary && binary_diff.unified.is_empty(),
            format!("binary diff was rendered as text: {binary_diff:?}"),
        )?;
        let large_diff = files
            .diff(
                crate::domain::DiffRequest {
                    right_file_identity: None,
                    scope: review_scope("//depot/p4deck-submit-e2e/review/large.txt"),
                    left: crate::domain::RevisionReference::Have,
                    right: crate::domain::RevisionReference::Workspace,
                    refresh: true,
                    operation_id: Some("review-large".into()),
                },
                None,
            )
            .await?;
        ensure(
            large_diff.unsupported && large_diff.truncated && large_diff.partial,
            format!("large diff did not report its safety limit: {large_diff:?}"),
        )?;
        make_writable(&special_local)?;
        std::fs::remove_file(&special_local).map_err(|error| error.to_string())?;
        let missing_diff = files
            .diff(
                crate::domain::DiffRequest {
                    right_file_identity: None,
                    scope: review_scope(special_depot),
                    left: crate::domain::RevisionReference::Have,
                    right: crate::domain::RevisionReference::Workspace,
                    refresh: true,
                    operation_id: Some("review-missing-workspace".into()),
                },
                None,
            )
            .await?;
        ensure(
            !missing_diff.right.exists && missing_diff.stats.deletions > 0,
            format!(
                "missing workspace file was not represented as an empty side: {missing_diff:?}"
            ),
        )?;
        checked_run(
            runner,
            context,
            "sync",
            vec!["-f".into(), special_filespec],
            None,
            OutputMode::Text,
        )
        .await?;
        ensure(
            files
                .history(
                    crate::domain::FileHistoryRequest {
                        scope: review_scope("//depot/p4deck-submit-e2e/review/not-mapped.txt"),
                        page_size: 10,
                        cursor: None,
                        refresh: true,
                        operation_id: Some("review-missing-depot".into()),
                    },
                    None,
                )
                .await
                .is_err(),
            "missing depot file unexpectedly returned history",
        )?;
        let graph = files
            .graph(
                crate::domain::RevisionGraphRequest {
                    scope: review_scope(moved_path),
                    revision_limit: 100,
                    cursor: None,
                    refresh: false,
                    operation_id: Some("review-integration-graph".into()),
                },
                None,
            )
            .await?;
        ensure(
            graph.edges.iter().any(|edge| edge.kind == "branch")
                && graph.edges.iter().any(|edge| edge.kind == "merge")
                && graph.edges.iter().any(|edge| edge.kind == "copy")
                && graph.edges.iter().any(|edge| edge.kind == "move")
                && graph.nodes.iter().any(|node| node.depot_path == moved_path)
                && graph
                    .nodes
                    .iter()
                    .any(|node| node.depot_path == "//depot/p4deck-submit-e2e/success.txt"),
            format!("revision graph omitted the real branch edge: {graph:?}"),
        )?;

        let mut second_page_query = first_page_query.clone();
        second_page_query.operation_id = "be009-page-2".into();
        second_page_query.request_generation = 91;
        second_page_query.cursor = first_page.next_cursor.clone();
        let second_page = changelists
            .query(context.clone(), second_page_query.clone(), None)
            .await?;
        ensure(
            second_page.items.len() == 1
                && second_page.items[0].id != first_id
                && second_page.items[0].id != inserted_id
                && second_page.items[0].id < first_id,
            format!("cursor page repeated or admitted a newly inserted change: {second_page:?}"),
        )?;

        let mut combined = query(false);
        combined.operation_id = "be009-combined".into();
        combined.request_generation = 92;
        combined.keyword = "indexed job combined query".into();
        combined.users = vec![FIXTURE_USER.into()];
        combined.clients = vec![E2E_CLIENT.into()];
        combined.depot_path = Some("//depot/p4deck-submit-e2e/...".into());
        combined.stream = Some("//depot/p4deck-submit-e2e".into());
        combined.jobs = vec![E2E_JOB.into()];
        combined.has_job = Some(true);
        combined.merge_classifications = vec![crate::domain::MergeClassification::Unknown];
        combined.page_size = 10;
        let combined_result = changelists.query(context.clone(), combined, None).await?;
        ensure(
            combined_result.items.iter().any(|change| {
                change.id == inserted_id
                    && change.jobs.contains(&E2E_JOB.to_owned())
                    && change.user == FIXTURE_USER
                    && change.client == E2E_CLIENT
            }),
            format!("combined submitted filters missed the indexed job: {combined_result:?}"),
        )?;
        checked_run(
            runner,
            context,
            "fix",
            vec![
                "-d".into(),
                "-c".into(),
                inserted_id.to_string(),
                E2E_JOB.into(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "job",
            vec!["-d".into(), E2E_JOB.into()],
            None,
            OutputMode::Text,
        )
        .await?;

        let mut invalid = second_page_query.clone();
        invalid.operation_id = "be009-invalid-cursor".into();
        invalid.cursor = Some("not-a-cursor".into());
        ensure(
            changelists
                .query(context.clone(), invalid, None)
                .await
                .is_err(),
            "an invalid submitted cursor was accepted",
        )?;
        let mut mismatched = second_page_query.clone();
        mismatched.operation_id = "be009-mismatched-cursor".into();
        mismatched.keyword = "different query".into();
        ensure(
            changelists
                .query(context.clone(), mismatched, None)
                .await
                .is_err(),
            "a submitted cursor was accepted for different filters",
        )?;

        let mut cancellation = query(false);
        cancellation.operation_id = "be009-cancel-query".into();
        cancellation.request_generation = 93;
        cancellation.has_job = Some(false);
        cancellation.page_size = 500;
        let cancel_id = cancellation.operation_id.clone();
        let cancel = async {
            tokio::task::yield_now().await;
            runner.cancel(&cancel_id);
        };
        let (cancelled, ()) = tokio::join!(
            changelists.query(context.clone(), cancellation, None),
            cancel
        );
        ensure(
            cancelled.is_err(),
            "submitted query cancellation was ignored",
        )?;

        let review_cancel_id = "review-history-cancel".to_string();
        let review_cancellation = files.history(
            crate::domain::FileHistoryRequest {
                scope: review_scope("//depot/p4deck-submit-e2e/success.txt"),
                page_size: 500,
                cursor: None,
                refresh: true,
                operation_id: Some(review_cancel_id.clone()),
            },
            None,
        );
        let cancel_review = async {
            runner.cancel(&review_cancel_id);
        };
        let (cancelled_review, ()) = tokio::join!(review_cancellation, cancel_review);
        ensure(
            cancelled_review.is_err_and(|error| error.to_ascii_lowercase().contains("cancel")),
            "file review cancellation was ignored or surfaced as a normal result",
        )?;
        let review_after_cancel = files
            .history(
                crate::domain::FileHistoryRequest {
                    scope: review_scope("//depot/p4deck-submit-e2e/success.txt"),
                    page_size: 10,
                    cursor: None,
                    refresh: true,
                    operation_id: Some("review-history-after-cancel".into()),
                },
                None,
            )
            .await?;
        ensure(
            !review_after_cancel.items.is_empty(),
            "normal file review history regressed after cancellation",
        )?;

        let mut switched = context.clone();
        switched.client = "p4deck-fixture-cursor-generation".into();
        contexts.save(switched).map_err(|error| error.to_string())?;
        contexts
            .save(context.clone())
            .map_err(|error| error.to_string())?;
        second_page_query.operation_id = "be009-old-generation-cursor".into();
        ensure(
            changelists
                .query(context.clone(), second_page_query, None)
                .await
                .is_err(),
            "a submitted cursor survived a connection generation change",
        )?;
        ensure(
            files
                .history(
                    crate::domain::FileHistoryRequest {
                        scope: review_scope("//depot/p4deck-submit-e2e/success.txt"),
                        page_size: 10,
                        cursor: None,
                        refresh: true,
                        operation_id: Some("review-generation-drift".into()),
                    },
                    None,
                )
                .await
                .is_err(),
            "file review accepted a stale context generation",
        )
    }

    async fn exercise_global_search(
        runner: &Arc<P4Runner>,
        changelists: &ChangelistService,
        search: &GlobalSearchService,
        contexts: &ContextStore,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        use crate::domain::{GlobalSearchKind, GlobalSearchQuery};

        let suffix = Uuid::new_v4().simple().to_string();
        let stream_root = root
            .parent()
            .ok_or("fixture workspace has no parent")?
            .join("global-search-stream-workspace");
        setup_stream_fixture(runner, context, &stream_root).await?;
        let file_name = format!("global-search-fixture-[x]-{}.txt", &suffix[..8]);
        let local_dir = root.join("global-search-e2e");
        std::fs::create_dir_all(&local_dir).map_err(|error| error.to_string())?;
        let local = local_dir.join(&file_name);
        std::fs::write(&local, b"global search fixture\n").map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "add",
            vec![local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-d".into(), "global-search-fixture submitted".into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;

        let job_id = format!("P4DECK-GLOBAL-{}", &suffix[..8]);
        checked_run(
            runner,
            context,
            "job",
            vec!["-i".into()],
            Some(format!(
                "Job: {job_id}\nStatus: open\nUser: {FIXTURE_USER}\nDescription:\n\tglobal-search-fixture job\n"
            )),
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "edit",
            vec![local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let pending = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("global-search-create-pending".into()),
                    mutation: PendingChangeMutation::Create {
                        description: "global-search-fixture pending".into(),
                        jobs: vec![job_id.clone()],
                    },
                },
                None,
            )
            .await?;
        let pending_id = pending
            .created_change_id
            .ok_or("global search pending changelist was not created")?;
        move_to_change(
            changelists,
            context,
            pending_id,
            &format!("//depot/global-search-e2e/{file_name}"),
        )
        .await?;
        checked_run(
            runner,
            context,
            "shelve",
            vec!["-c".into(), pending_id.to_string()],
            None,
            OutputMode::JsonLines,
        )
        .await?;

        let path_token = format!("shelf-path-only-{}", &suffix[..8]);
        let shelf_names = [format!("{path_token}-a.txt"), format!("{path_token}-b.txt")];
        let shelf_paths = shelf_names
            .iter()
            .map(|name| local_dir.join(name))
            .collect::<Vec<_>>();
        for path in &shelf_paths {
            std::fs::write(path, b"shelf path search fixture\n")
                .map_err(|error| error.to_string())?;
        }
        checked_run(
            runner,
            context,
            "add",
            shelf_paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let path_shelf = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("global-search-create-path-shelf".into()),
                    mutation: PendingChangeMutation::Create {
                        description: "opaque shelf metadata alpha".into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?
            .created_change_id
            .ok_or("path-only shelf changelist was not created")?;
        for name in &shelf_names {
            move_to_change(
                changelists,
                context,
                path_shelf,
                &format!("//depot/global-search-e2e/{name}"),
            )
            .await?;
        }
        checked_run(
            runner,
            context,
            "shelve",
            vec!["-c".into(), path_shelf.to_string()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        let opened_before_search = event_text(
            &checked_run(
                runner,
                context,
                "opened",
                vec!["-c".into(), path_shelf.to_string()],
                None,
                OutputMode::JsonLines,
            )
            .await?,
        );
        let shelf_before_search = event_text(
            &checked_run(
                runner,
                context,
                "describe",
                vec!["-s".into(), "-S".into(), path_shelf.to_string()],
                None,
                OutputMode::JsonLines,
            )
            .await?,
        );

        let kinds = vec![
            GlobalSearchKind::SubmittedChange,
            GlobalSearchKind::PendingChange,
            GlobalSearchKind::WorkspaceFile,
            GlobalSearchKind::DepotFile,
            GlobalSearchKind::Stream,
            GlobalSearchKind::Shelf,
        ];
        let base = GlobalSearchQuery {
            operation_id: "global-search-page-1".into(),
            request_generation: 100,
            text: "global-search-fixture".into(),
            kinds: kinds.clone(),
            page_size: 2,
            cursor: None,
        };
        let first = search
            .query(base.clone(), None)
            .await
            .map_err(|error| error.message)?;
        ensure(
            first.has_more && first.next_cursor.is_some() && !first.simulated,
            format!("global search did not return a real paged result: {first:?}"),
        )?;
        ensure(
            first.facets.iter().all(|facet| facet.error.is_none())
                && kinds.iter().all(|kind| {
                    first
                        .facets
                        .iter()
                        .any(|facet| facet.kind == *kind && facet.scanned_count > 0)
                }),
            format!(
                "global search did not cover every production kind: {:?}",
                first.facets
            ),
        )?;
        let first_cursor = first.next_cursor.clone().unwrap();
        let mut identities = HashSet::new();
        let mut returned_kinds = HashSet::new();
        let mut page = first;
        loop {
            for item in page.groups.iter().flat_map(|group| &group.items) {
                returned_kinds.insert(item.kind);
                ensure(
                    identities.insert(item.identity.clone()),
                    format!("global search repeated identity {}", item.identity),
                )?;
            }
            let Some(cursor) = page.next_cursor.clone() else {
                break;
            };
            let mut next = base.clone();
            next.operation_id = format!("global-search-page-{}", identities.len());
            next.request_generation += identities.len() as u64;
            next.cursor = Some(cursor);
            page = search
                .query(next, None)
                .await
                .map_err(|error| error.message)?;
        }
        ensure(
            kinds.iter().all(|kind| returned_kinds.contains(kind)),
            format!("global search pages did not cover all six kinds: {returned_kinds:?}"),
        )?;
        let mut replayed = base.clone();
        replayed.operation_id = "global-search-replay".into();
        replayed.cursor = Some(first_cursor.clone());
        ensure(
            search.query(replayed, None).await.is_err(),
            "a consumed global search cursor was replayable",
        )?;

        let path_only = search
            .query(
                GlobalSearchQuery {
                    operation_id: "global-search-shelf-path".into(),
                    request_generation: 109,
                    text: path_token.clone(),
                    kinds: vec![GlobalSearchKind::Shelf],
                    page_size: 20,
                    cursor: None,
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        let path_items = path_only
            .groups
            .iter()
            .flat_map(|group| &group.items)
            .collect::<Vec<_>>();
        ensure(
            path_items.len() == 1
                && path_items[0].identity == format!("shelf:{path_shelf}")
                && path_items[0].summary.contains("2 matching files"),
            format!("shelf file-path deep search was not deduplicated: {path_only:?}"),
        )?;

        for (text, expected) in [
            (MAIN_STREAM, MAIN_STREAM),
            (FIXTURE_USER, MAIN_STREAM),
            ("mainline", MAIN_STREAM),
            (MAIN_STREAM, DEV_STREAM),
            ("global-search-fixture", MAIN_STREAM),
            ("virtual", VIRTUAL_STREAM),
            ("task", TASK_STREAM),
        ] {
            let found = search
                .query(
                    GlobalSearchQuery {
                        operation_id: format!("global-search-stream-{}", Uuid::new_v4()),
                        request_generation: 109,
                        text: text.into(),
                        kinds: vec![GlobalSearchKind::Stream],
                        page_size: 100,
                        cursor: None,
                    },
                    None,
                )
                .await
                .map_err(|error| error.message)?;
            ensure(
                found
                    .groups
                    .iter()
                    .flat_map(|group| &group.items)
                    .any(|item| {
                        matches!(
                            &item.target,
                            crate::domain::GlobalSearchTarget::Stream { stream_path }
                                if stream_path == expected
                        )
                    }),
                format!("stream search {text:?} did not find {expected}: {found:?}"),
            )?;
        }

        let no_shelf = search
            .query(
                GlobalSearchQuery {
                    operation_id: "global-search-shelf-none".into(),
                    request_generation: 109,
                    text: format!("no-such-shelf-{suffix}"),
                    kinds: vec![GlobalSearchKind::Shelf],
                    page_size: 20,
                    cursor: None,
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        ensure(
            no_shelf.stats.matched_count == 0,
            format!("missing shelf search forged a result: {no_shelf:?}"),
        )?;

        let special = search
            .query(
                GlobalSearchQuery {
                    operation_id: "global-search-special".into(),
                    request_generation: 110,
                    text: "[x]".into(),
                    kinds: vec![GlobalSearchKind::WorkspaceFile, GlobalSearchKind::DepotFile],
                    page_size: 20,
                    cursor: None,
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        ensure(
            special.stats.matched_count > 0,
            "literal special-character file search returned no results",
        )?;
        let unicode = search
            .query(
                GlobalSearchQuery {
                    operation_id: "global-search-unicode".into(),
                    request_generation: 111,
                    text: "你好".into(),
                    kinds: vec![GlobalSearchKind::Shelf],
                    page_size: 20,
                    cursor: None,
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        ensure(
            unicode.facets.len() == 1 && unicode.facets[0].error.is_none(),
            format!("Unicode search was not safely treated as a literal: {unicode:?}"),
        )?;

        let mut invalid = base.clone();
        invalid.operation_id = "global-search-invalid-cursor".into();
        invalid.cursor = Some("not-a-cursor".into());
        ensure(
            search.query(invalid, None).await.is_err(),
            "an invalid global search cursor was accepted",
        )?;
        let mut mismatched = base.clone();
        mismatched.operation_id = "global-search-mismatched-cursor".into();
        mismatched.text = "different".into();
        mismatched.cursor = Some(first_cursor.clone());
        ensure(
            search.query(mismatched, None).await.is_err(),
            "a global search cursor was accepted for a different query",
        )?;
        let mut wrong_page_size = base.clone();
        wrong_page_size.operation_id = "global-search-page-size-cursor".into();
        wrong_page_size.page_size = 3;
        wrong_page_size.cursor = Some(first_cursor.clone());
        ensure(
            search.query(wrong_page_size, None).await.is_err(),
            "a global search cursor was accepted for a different page size",
        )?;

        let mut switched = context.clone();
        switched.client = "p4deck-fixture-global-generation".into();
        contexts.save(switched).map_err(|error| error.to_string())?;
        contexts
            .save(context.clone())
            .map_err(|error| error.to_string())?;
        let mut stale = base.clone();
        stale.operation_id = "global-search-old-generation".into();
        stale.cursor = Some(first_cursor);
        ensure(
            search.query(stale, None).await.is_err(),
            "a global search cursor survived a connection generation change",
        )?;

        let opened_after_search = event_text(
            &checked_run(
                runner,
                context,
                "opened",
                vec!["-c".into(), path_shelf.to_string()],
                None,
                OutputMode::JsonLines,
            )
            .await?,
        );
        let shelf_after_search = event_text(
            &checked_run(
                runner,
                context,
                "describe",
                vec!["-s".into(), "-S".into(), path_shelf.to_string()],
                None,
                OutputMode::JsonLines,
            )
            .await?,
        );
        ensure(
            opened_before_search == opened_after_search
                && shelf_before_search == shelf_after_search,
            "global search changed opened state or shelf contents",
        )?;

        checked_run(
            runner,
            context,
            "revert",
            shelf_paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "shelve",
            vec!["-d".into(), "-c".into(), path_shelf.to_string()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        delete_empty_change(changelists, context, path_shelf).await?;

        checked_run(
            runner,
            context,
            "revert",
            vec![local.to_string_lossy().into_owned()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        checked_run(
            runner,
            context,
            "shelve",
            vec!["-d".into(), "-c".into(), pending_id.to_string()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("global-search-clear-pending-job".into()),
                    mutation: PendingChangeMutation::Edit {
                        change_id: pending_id,
                        description: "global-search-fixture pending cleanup".into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?;
        delete_empty_change(changelists, context, pending_id).await?;
        checked_run(
            runner,
            context,
            "job",
            vec!["-d".into(), job_id],
            None,
            OutputMode::Text,
        )
        .await?;

        let limit_probe = checked_run(
            runner,
            context,
            "files",
            vec![
                "-m".into(),
                "1".into(),
                "//depot/global-search-limit/...".into(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        if !json_values(&limit_probe)
            .iter()
            .any(|value| value.get("depotFile").is_some())
        {
            let limit_dir = root.join("global-search-limit");
            std::fs::create_dir_all(&limit_dir).map_err(|error| error.to_string())?;
            let mut limit_paths = Vec::new();
            for index in 0..=1000 {
                let path = limit_dir.join(format!("partial-limit-fixture-{index:04}.txt"));
                std::fs::write(&path, b"bounded global search\n")
                    .map_err(|error| error.to_string())?;
                limit_paths.push(path.to_string_lossy().into_owned());
            }
            for chunk in limit_paths.chunks(100) {
                checked_run(
                    runner,
                    context,
                    "add",
                    chunk.to_vec(),
                    None,
                    OutputMode::JsonLines,
                )
                .await?;
            }
            checked_run(
                runner,
                context,
                "submit",
                vec!["-d".into(), "global search partial-limit fixture".into()],
                None,
                OutputMode::JsonLines,
            )
            .await?;
        }
        let partial = search
            .query(
                GlobalSearchQuery {
                    operation_id: "global-search-partial-limit".into(),
                    request_generation: 120,
                    text: "partial-limit-fixture".into(),
                    kinds: vec![GlobalSearchKind::DepotFile],
                    page_size: 100,
                    cursor: None,
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        ensure(
            partial.partial && partial.facets[0].partial && partial.facets[0].scanned_count == 1000,
            format!("global search did not expose the safety limit: {partial:?}"),
        )?;

        let cancellation = GlobalSearchQuery {
            operation_id: "global-search-cancel".into(),
            request_generation: 121,
            text: "global".into(),
            kinds: kinds.clone(),
            page_size: 100,
            cursor: None,
        };
        let cancel = async {
            tokio::task::yield_now().await;
            search.cancel("global-search-cancel");
            runner.cancel("global-search-cancel");
        };
        let (cancelled, ()) = tokio::join!(search.query(cancellation, None), cancel);
        ensure(
            cancelled.is_err_and(|error| {
                error.code == crate::domain::GlobalSearchRequestErrorCode::Cancelled
            }),
            "global search cancellation did not return a structured cancelled error",
        )
    }

    async fn latest_change_id(
        runner: &P4Runner,
        context: &P4Context,
        depot_path: &str,
    ) -> Result<i64, String> {
        let result = checked_run(
            runner,
            context,
            "changes",
            vec!["-m".into(), "1".into(), depot_path.into()],
            None,
            OutputMode::JsonLines,
        )
        .await?;
        json_values(&result)
            .into_iter()
            .find_map(|value| {
                value
                    .get("change")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse().ok())
            })
            .ok_or_else(|| format!("no submitted changelist found for {depot_path}"))
    }

    async fn exercise_submit_blockers(
        runner: &Arc<P4Runner>,
        changelists: &ChangelistService,
        submit: &SubmitService,
        sync: &SyncService,
        files: &FileService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let writer_root = root
            .parent()
            .ok_or("E2E workspace has no fixture parent")?
            .join("submit-writer-workspace");
        let writer = setup_named_client(runner, context, WRITER_CLIENT, &writer_root).await?;
        let scenario = async {
            let writer_outdated = writer_root.join("p4deck-submit-e2e").join("outdated.txt");
            std::fs::create_dir_all(writer_outdated.parent().expect("test path has parent"))
                .map_err(|error| error.to_string())?;
            std::fs::write(&writer_outdated, b"revision one\n")
                .map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "add",
                vec![writer_outdated.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "BE-003 out-of-date seed".into()],
                None,
                OutputMode::Text,
            )
            .await?;

            let outdated_depot = "//depot/p4deck-submit-e2e/outdated.txt".to_owned();
            confirmed_sync(sync, vec![outdated_depot.clone()], None).await?;
            let local_outdated = root
                .join("p4deck-submit-e2e")
                .join("outdated.txt")
                .to_string_lossy()
                .into_owned();
            action(
                files,
                context,
                FileAction::Checkout,
                vec![local_outdated.clone()],
            )
            .await?;
            let outdate_change =
                create_numbered_change(changelists, context, "BE-003 out-of-date").await?;
            move_to_change(changelists, context, outdate_change, &outdated_depot).await?;

            checked_run(
                runner,
                &writer,
                "sync",
                vec![outdated_depot.clone()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "edit",
                vec![writer_outdated.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            std::fs::write(&writer_outdated, b"revision two\n")
                .map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "BE-003 out-of-date head".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let outdate = submit
                .preflight(
                    SubmitPreflightRequest {
                        change_id: outdate_change,
                    },
                    None,
                )
                .await;
            ensure(
                has_blocker(&outdate, crate::domain::SubmitIssueCode::OutOfDateFiles),
                format!("out-of-date file was not blocked: {outdate:?}"),
            )?;
            action(files, context, FileAction::Revert, vec![local_outdated]).await?;
            delete_empty_change(changelists, context, outdate_change).await?;

            let writer_main = writer_root
                .join("p4deck-submit-e2e")
                .join("integration")
                .join("main.txt");
            std::fs::create_dir_all(writer_main.parent().expect("test path has parent"))
                .map_err(|error| error.to_string())?;
            std::fs::write(&writer_main, b"base\n").map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "add",
                vec![writer_main.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "BE-003 integration seed".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let integration_main = "//depot/p4deck-submit-e2e/integration/main.txt";
            let integration_branch = "//depot/p4deck-submit-e2e/integration/branch.txt";
            checked_run(
                runner,
                &writer,
                "integrate",
                vec![integration_main.into(), integration_branch.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "resolve",
                vec!["-at".into(), integration_branch.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "BE-003 integration branch".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &writer,
                "edit",
                vec![writer_main.to_string_lossy().into_owned()],
                None,
                OutputMode::Text,
            )
            .await?;
            std::fs::write(&writer_main, b"main changed after branch\n")
                .map_err(|error| error.to_string())?;
            checked_run(
                runner,
                &writer,
                "submit",
                vec!["-d".into(), "BE-003 integration source update".into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                context,
                "sync",
                vec![format!("//depot/p4deck-submit-e2e/integration/...")],
                None,
                OutputMode::Text,
            )
            .await?;
            let unresolved_change =
                create_numbered_change(changelists, context, "BE-003 unresolved").await?;
            checked_run(
                runner,
                context,
                "integrate",
                vec![
                    "-c".into(),
                    unresolved_change.to_string(),
                    integration_main.into(),
                    integration_branch.into(),
                ],
                None,
                OutputMode::Text,
            )
            .await?;
            let unresolved = submit
                .preflight(
                    SubmitPreflightRequest {
                        change_id: unresolved_change,
                    },
                    None,
                )
                .await;
            ensure(
                has_blocker(&unresolved, crate::domain::SubmitIssueCode::UnresolvedFiles),
                format!("unresolved integration was not blocked: {unresolved:?}"),
            )?;
            checked_run(
                runner,
                context,
                "revert",
                vec![integration_branch.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            delete_empty_change(changelists, context, unresolved_change).await
        }
        .await;
        let cleanup = cleanup_named_client(runner, context, WRITER_CLIENT, &writer_root).await;
        match (scenario, cleanup) {
            (Err(error), Err(cleanup_error)) => Err(format!(
                "{error}; writer cleanup also failed: {cleanup_error}"
            )),
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    async fn exercise_shelf_unshelve_resolve(
        runner: &Arc<P4Runner>,
        files: &FileService,
        changelists: &ChangelistService,
        workflow_services: (&WorkflowService, &WorkflowService),
        contexts: &ContextStore,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let (workflows, expiring_workflows) = workflow_services;
        const A: &str = "//depot/p4deck-workflow-e2e/a.txt";
        const B: &str = "//depot/p4deck-workflow-e2e/b.txt";
        const TARGET_CLIENT: &str = "p4deck-fixture-workflow-target";
        const LIMITED_CLIENT: &str = "p4deck-fixture-workflow-limited";
        const LOCK_CLIENT: &str = "p4deck-fixture-workflow-lock";
        let local_dir = root.join("p4deck-workflow-e2e");
        std::fs::create_dir_all(&local_dir).map_err(|error| error.to_string())?;
        let local_a = local_dir.join("a.txt");
        let local_b = local_dir.join("b.txt");
        std::fs::write(&local_a, b"base a\n").map_err(|error| error.to_string())?;
        std::fs::write(&local_b, b"base b\n").map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "add",
            vec![A.into(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "reopen",
            vec!["-t".into(), "binary".into(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec![
                "-d".into(),
                "BE-004b workflow seed".into(),
                "//depot/p4deck-workflow-e2e/...".into(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "edit",
            vec![A.into(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        std::fs::write(&local_a, b"shelf a v1\n").map_err(|error| error.to_string())?;
        std::fs::write(&local_b, b"shelf b v1\n").map_err(|error| error.to_string())?;
        let source_change =
            create_numbered_change(changelists, context, "BE-004b source shelf").await?;
        for path in [A, B] {
            move_to_change(changelists, context, source_change, path).await?;
        }

        let first_a = workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![A.into()],
                    mode: ShelfMode::CreateOrUpdate,
                    replace: false,
                },
                None,
            )
            .await;
        ensure(
            first_a.ready && first_a.scope.create_paths == [A],
            format!("partial first shelf was not ready: {first_a:?}"),
        )?;
        let first_a_result = workflows
            .confirm_shelf(
                WorkflowConfirmation {
                    token: first_a
                        .token
                        .clone()
                        .ok_or("first shelf returned no token")?,
                    target: first_a.target.clone(),
                    operation_id: Some("be004b-shelf-a".into()),
                },
                None,
            )
            .await;
        ensure(
            first_a_result.outcome == WorkflowOutcome::Succeeded,
            format!("first partial shelf failed: {first_a_result:?}"),
        )?;

        let first_b = workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![B.into()],
                    mode: ShelfMode::CreateOrUpdate,
                    replace: false,
                },
                None,
            )
            .await;
        let first_b_result = workflows
            .confirm_shelf(
                WorkflowConfirmation {
                    token: first_b
                        .token
                        .clone()
                        .ok_or("second partial shelf returned no token")?,
                    target: first_b.target.clone(),
                    operation_id: Some("be004b-shelf-b".into()),
                },
                None,
            )
            .await;
        ensure(
            first_b_result.outcome == WorkflowOutcome::Succeeded,
            format!("second partial shelf failed: {first_b_result:?}"),
        )?;
        let after_first = changelists.query_pending(context.clone(), None).await?;
        ensure(
            pending_change(&after_first, source_change)?
                .shelved_files
                .len()
                == 2,
            "partial shelf did not preserve both selected shelf revisions",
        )?;
        let shelf_detail = workflows
            .shelf_detail(
                ShelfDetailRequest {
                    change_id: source_change,
                    request_generation: 1,
                    page_size: 1,
                    cursor: None,
                    refresh: true,
                    operation_id: Some("be004b-shelf-detail".into()),
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        ensure(
            shelf_detail.total_files == 2
                && shelf_detail.files.len() == 1
                && shelf_detail.has_more
                && shelf_detail.next_cursor.is_some()
                && shelf_detail.files[0].depot_path == A
                && !shelf_detail.files[0].binary,
            format!("typed shelf detail was incomplete or unstable: {shelf_detail:?}"),
        )?;
        let shelf_cursor = shelf_detail
            .next_cursor
            .clone()
            .ok_or("shelf detail did not issue a continuation cursor")?;
        let shelf_detail_second = workflows
            .shelf_detail(
                ShelfDetailRequest {
                    change_id: source_change,
                    request_generation: 2,
                    page_size: 1,
                    cursor: Some(shelf_cursor.clone()),
                    refresh: false,
                    operation_id: Some("be004b-shelf-detail-page-2".into()),
                },
                None,
            )
            .await
            .map_err(|error| error.message)?;
        ensure(
            shelf_detail_second.request_generation == 2
                && shelf_detail_second.files.len() == 1
                && !shelf_detail_second.has_more
                && shelf_detail_second.next_cursor.is_none()
                && shelf_detail_second.files[0].depot_path == B,
            format!("typed shelf cursor page was incomplete or unstable: {shelf_detail_second:?}"),
        )?;
        let replay = workflows
            .shelf_detail(
                ShelfDetailRequest {
                    change_id: source_change,
                    request_generation: 3,
                    page_size: 1,
                    cursor: Some(shelf_cursor),
                    refresh: false,
                    operation_id: Some("be004b-shelf-detail-replay".into()),
                },
                None,
            )
            .await
            .expect_err("a consumed shelf cursor must not be replayable");
        ensure(
            replay.code == crate::domain::ShelfDetailRequestErrorCode::InvalidCursor,
            format!("shelf cursor replay returned the wrong error: {replay:?}"),
        )?;
        let (_, generation) = contexts.snapshot();
        let text_preview = files
            .shelf_preview(
                ShelfFilePreviewRequest {
                    scope: crate::domain::FileReviewScope {
                        server: context.server.clone(),
                        user: context.user.clone(),
                        client: context.client.clone(),
                        workspace: context.cwd.clone().unwrap_or_default(),
                        active_profile_id: contexts.active_profile_id(),
                        context_generation: generation,
                        file_identity: A.into(),
                    },
                    change_id: source_change,
                    refresh: true,
                    operation_id: Some("be004b-shelf-preview".into()),
                },
                None,
            )
            .await?;
        ensure(
            !text_preview.side.binary
                && text_preview
                    .content
                    .as_deref()
                    .is_some_and(|content| content.contains("shelf a v1")),
            format!("text shelf preview did not return shelved content: {text_preview:?}"),
        )?;
        let binary_preview = files
            .shelf_preview(
                ShelfFilePreviewRequest {
                    scope: crate::domain::FileReviewScope {
                        server: context.server.clone(),
                        user: context.user.clone(),
                        client: context.client.clone(),
                        workspace: context.cwd.clone().unwrap_or_default(),
                        active_profile_id: contexts.active_profile_id(),
                        context_generation: generation,
                        file_identity: B.into(),
                    },
                    change_id: source_change,
                    refresh: true,
                    operation_id: Some("be004b-binary-shelf-preview".into()),
                },
                None,
            )
            .await?;
        ensure(
            binary_preview.side.binary
                && binary_preview.content.is_none()
                && binary_preview.reason.is_some(),
            format!("binary shelf preview was treated as text: {binary_preview:?}"),
        )?;

        let replace_required = workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![A.into()],
                    mode: ShelfMode::CreateOrUpdate,
                    replace: false,
                },
                None,
            )
            .await;
        ensure(
            !replace_required.ready
                && replace_required
                    .blockers
                    .iter()
                    .any(|item| item.code == WorkflowIssueCode::ExistingShelfRequiresReplace),
            format!("existing shelf replacement was not blocked: {replace_required:?}"),
        )?;

        let drift = workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![A.into()],
                    mode: ShelfMode::CreateOrUpdate,
                    replace: true,
                },
                None,
            )
            .await;
        std::fs::write(&local_a, b"shelf a v2 drift\n").map_err(|error| error.to_string())?;
        let drift_result = workflows
            .confirm_shelf(
                WorkflowConfirmation {
                    token: drift.token.ok_or("drift preflight returned no token")?,
                    target: drift.target,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            drift_result.failure == Some(WorkflowFailureCode::ContentChanged),
            format!("local content drift did not invalidate shelf token: {drift_result:?}"),
        )?;

        let expiring = expiring_workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![A.into()],
                    mode: ShelfMode::CreateOrUpdate,
                    replace: true,
                },
                None,
            )
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
        let expired = expiring_workflows
            .confirm_shelf(
                WorkflowConfirmation {
                    token: expiring.token.ok_or("expiring shelf returned no token")?,
                    target: expiring.target,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            expired.failure == Some(WorkflowFailureCode::TokenExpired),
            format!("expired shelf token was not rejected: {expired:?}"),
        )?;

        let replace = workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![A.into()],
                    mode: ShelfMode::CreateOrUpdate,
                    replace: true,
                },
                None,
            )
            .await;
        let replace_result = workflows
            .confirm_shelf(
                WorkflowConfirmation {
                    token: replace.token.ok_or("replacement returned no token")?,
                    target: replace.target,
                    operation_id: Some("be004b-replace-a".into()),
                },
                None,
            )
            .await;
        ensure(
            replace_result.outcome == WorkflowOutcome::Succeeded,
            format!("shelf replacement failed: {replace_result:?}"),
        )?;

        let target_root = root
            .parent()
            .ok_or("fixture root is missing")?
            .join("workflow-target-workspace");
        let target_context =
            setup_named_client(runner, context, TARGET_CLIENT, &target_root).await?;
        let stale_source = workflows
            .preflight_unshelve(
                UnshelvePreflightRequest {
                    source_change_id: source_change,
                    depot_paths: vec![B.into()],
                    target_workspace: TARGET_CLIENT.into(),
                    target_change_id: 0,
                },
                None,
            )
            .await;
        ensure(
            stale_source.ready,
            format!("source drift setup preflight was not ready: {stale_source:?}"),
        )?;
        std::fs::write(&local_b, b"shelf b v2 source drift\n")
            .map_err(|error| error.to_string())?;
        let update_b = workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![B.into()],
                    mode: ShelfMode::CreateOrUpdate,
                    replace: true,
                },
                None,
            )
            .await;
        let update_b_result = workflows
            .confirm_shelf(
                WorkflowConfirmation {
                    token: update_b
                        .token
                        .ok_or("source shelf update returned no token")?,
                    target: update_b.target,
                    operation_id: Some("be004b-source-drift".into()),
                },
                None,
            )
            .await;
        ensure(
            update_b_result.outcome == WorkflowOutcome::Succeeded,
            format!("source shelf update failed: {update_b_result:?}"),
        )?;
        let stale_source_result = workflows
            .confirm_unshelve(
                WorkflowConfirmation {
                    token: stale_source
                        .token
                        .ok_or("source drift unshelve returned no token")?,
                    target: stale_source.target,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            stale_source_result.failure == Some(WorkflowFailureCode::ContentChanged),
            format!("source shelf drift did not invalidate token: {stale_source_result:?}"),
        )?;
        let limited_root = root
            .parent()
            .ok_or("fixture root is missing")?
            .join("workflow-limited-workspace");
        if limited_root.exists() {
            std::fs::remove_dir_all(&limited_root).map_err(|error| error.to_string())?;
        }
        std::fs::create_dir_all(&limited_root).map_err(|error| error.to_string())?;
        let limited_spec = format!("Client: {LIMITED_CLIENT}\nOwner: {FIXTURE_USER}\nRoot: {}\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nLineEnd: local\nView:\n\t//depot/main/... //{LIMITED_CLIENT}/main/...\n", limited_root.to_string_lossy().replace('\\', "/"));
        checked_run(
            runner,
            context,
            "client",
            vec!["-i".into()],
            Some(limited_spec),
            OutputMode::Text,
        )
        .await?;

        let mapping_failure = workflows
            .preflight_unshelve(
                UnshelvePreflightRequest {
                    source_change_id: source_change,
                    depot_paths: vec![B.into()],
                    target_workspace: LIMITED_CLIENT.into(),
                    target_change_id: 0,
                },
                None,
            )
            .await;
        ensure(
            mapping_failure
                .blockers
                .iter()
                .any(|item| item.code == WorkflowIssueCode::MappingFailed),
            format!("unmapped target was not classified: {mapping_failure:?}"),
        )?;

        let lock_root = root
            .parent()
            .ok_or("fixture root is missing")?
            .join("workflow-lock-workspace");
        let lock_context = setup_named_client(runner, context, LOCK_CLIENT, &lock_root).await?;
        checked_run(
            runner,
            &lock_context,
            "sync",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &lock_context,
            "edit",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &lock_context,
            "lock",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        let locked = workflows
            .preflight_unshelve(
                UnshelvePreflightRequest {
                    source_change_id: source_change,
                    depot_paths: vec![B.into()],
                    target_workspace: TARGET_CLIENT.into(),
                    target_change_id: 0,
                },
                None,
            )
            .await;
        ensure(
            locked
                .blockers
                .iter()
                .any(|item| item.code == WorkflowIssueCode::LockedFile),
            format!("cross-workspace lock was not blocked: {locked:?}"),
        )?;
        checked_run(
            runner,
            &lock_context,
            "unlock",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &lock_context,
            "revert",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        cleanup_named_client(runner, context, LOCK_CLIENT, &lock_root).await?;

        let to_default = workflows
            .preflight_unshelve(
                UnshelvePreflightRequest {
                    source_change_id: source_change,
                    depot_paths: vec![B.into()],
                    target_workspace: TARGET_CLIENT.into(),
                    target_change_id: 0,
                },
                None,
            )
            .await;
        ensure(
            to_default.ready && to_default.mappings.iter().all(|item| item.mapped),
            format!("cross-workspace Default unshelve was not ready: {to_default:?}"),
        )?;
        let default_result = workflows
            .confirm_unshelve(
                WorkflowConfirmation {
                    token: to_default
                        .token
                        .ok_or("Default unshelve returned no token")?,
                    target: to_default.target,
                    operation_id: Some("be004b-unshelve-default".into()),
                },
                None,
            )
            .await;
        ensure(
            default_result.outcome == WorkflowOutcome::Succeeded,
            format!("Default unshelve failed: {default_result:?}"),
        )?;
        checked_run(
            runner,
            &target_context,
            "revert",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;

        checked_run(
            runner,
            &target_context,
            "sync",
            vec!["-f".into(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;

        let target_change =
            create_numbered_change(changelists, &target_context, "BE-004b target resolve").await?;
        checked_run(
            runner,
            &target_context,
            "edit",
            vec!["-c".into(), target_change.to_string(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        let target_b = target_root.join("p4deck-workflow-e2e").join("b.txt");
        std::fs::write(&target_b, b"target workspace divergent b\n")
            .map_err(|error| error.to_string())?;
        let local_overlap = workflows
            .preflight_unshelve(
                UnshelvePreflightRequest {
                    source_change_id: source_change,
                    depot_paths: vec![B.into()],
                    target_workspace: TARGET_CLIENT.into(),
                    target_change_id: target_change,
                },
                None,
            )
            .await;
        ensure(
            !local_overlap.ready
                && local_overlap
                    .blockers
                    .iter()
                    .any(|item| item.code == WorkflowIssueCode::LocalModification),
            format!("local overwrite risk was not blocked: {local_overlap:?}"),
        )?;
        checked_run(
            runner,
            &target_context,
            "revert",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            &target_context,
            "edit",
            vec!["-c".into(), target_change.to_string(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        let to_numbered = workflows
            .preflight_unshelve(
                UnshelvePreflightRequest {
                    source_change_id: source_change,
                    depot_paths: vec![B.into()],
                    target_workspace: TARGET_CLIENT.into(),
                    target_change_id: target_change,
                },
                None,
            )
            .await;
        ensure(
            to_numbered.ready
                && to_numbered.warnings.iter().any(|item| {
                    item.code == WorkflowIssueCode::AlreadyOpened
                        || item.code == WorkflowIssueCode::ResolveLikely
                }),
            format!("numbered unshelve did not report opened/resolve risk: {to_numbered:?}"),
        )?;
        let numbered_result = workflows
            .confirm_unshelve(
                WorkflowConfirmation {
                    token: to_numbered
                        .token
                        .ok_or("numbered unshelve returned no token")?,
                    target: to_numbered.target,
                    operation_id: Some("be004b-unshelve-numbered".into()),
                },
                None,
            )
            .await;
        ensure(
            numbered_result.outcome == WorkflowOutcome::Succeeded,
            format!("numbered unshelve failed: {numbered_result:?}"),
        )?;

        contexts
            .save(target_context.clone())
            .map_err(|error| error.to_string())?;
        let resolve = workflows
            .preflight_resolve(
                ResolvePreflightRequest {
                    depot_paths: vec![B.into()],
                    force: false,
                },
                None,
            )
            .await;
        ensure(
            resolve.ready && resolve.conflicts[0].status == "unresolved",
            format!("real resolve conflict was not exposed: {resolve:?}"),
        )?;
        let unresolved_status = files
            .workspace_children(
                target_context.clone(),
                Some(
                    target_root
                        .join("p4deck-workflow-e2e")
                        .to_string_lossy()
                        .into_owned(),
                ),
                true,
                None,
            )
            .await?;
        ensure(
            unresolved_status.items.iter().any(|node| {
                node.name == "b.txt"
                    && node.state == "conflicted"
                    && node.status.resolve == crate::domain::WorkspaceResolveState::Unresolved
            }),
            format!("unresolved workspace status was not exposed: {unresolved_status:?}"),
        )?;
        let resolve_result = workflows
            .confirm_resolve(
                ResolveConfirmation {
                    token: resolve.token.ok_or("resolve preflight returned no token")?,
                    target: resolve.target,
                    operation_id: Some("be004b-resolve".into()),
                    resolutions: vec![ResolveSelection {
                        depot_path: B.into(),
                        strategy: ResolveStrategy::AcceptTheirs,
                    }],
                },
                None,
            )
            .await;
        ensure(
            resolve_result.outcome == WorkflowOutcome::Succeeded,
            format!("real resolve failed: {resolve_result:?}"),
        )?;
        let no_conflict = workflows
            .preflight_resolve(
                ResolvePreflightRequest {
                    depot_paths: vec![A.into()],
                    force: false,
                },
                None,
            )
            .await;
        ensure(
            !no_conflict.ready && no_conflict.conflicts[0].status != "unresolved",
            format!("non-conflict was falsely advertised as resolvable: {no_conflict:?}"),
        )?;
        contexts
            .save(context.clone())
            .map_err(|error| error.to_string())?;

        checked_run(
            runner,
            &target_context,
            "revert",
            vec![B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        delete_empty_change(changelists, &target_context, target_change).await?;
        cleanup_named_client(runner, context, TARGET_CLIENT, &target_root).await?;
        cleanup_named_client(runner, context, LIMITED_CLIENT, &limited_root).await?;

        let delete_a = workflows
            .preflight_shelf(
                ShelfPreflightRequest {
                    change_id: source_change,
                    depot_paths: vec![A.into()],
                    mode: ShelfMode::Delete,
                    replace: false,
                },
                None,
            )
            .await;
        let delete_a_result = workflows
            .confirm_shelf(
                WorkflowConfirmation {
                    token: delete_a.token.ok_or("delete shelf returned no token")?,
                    target: delete_a.target,
                    operation_id: Some("be004b-delete-a".into()),
                },
                None,
            )
            .await;
        ensure(
            delete_a_result.outcome == WorkflowOutcome::Succeeded,
            format!("shelf subset delete failed: {delete_a_result:?}"),
        )?;
        let remaining = changelists.query_pending(context.clone(), None).await?;
        let remaining = &pending_change(&remaining, source_change)?.shelved_files;
        ensure(
            remaining.iter().any(|file| file.depot_path == B)
                && remaining.iter().all(|file| file.depot_path != A),
            format!("shelf subset delete changed the wrong scope: {remaining:?}"),
        )?;

        checked_run(
            runner,
            context,
            "revert",
            vec![A.into(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "shelve",
            vec!["-d".into(), "-c".into(), source_change.to_string()],
            None,
            OutputMode::Text,
        )
        .await?;
        delete_empty_change(changelists, context, source_change).await?;
        exercise_manual_text_merge(runner, changelists, workflows, context, root).await?;
        Ok(())
    }

    async fn exercise_manual_text_merge(
        runner: &Arc<P4Runner>,
        changelists: &ChangelistService,
        workflows: &WorkflowService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let directory = format!("p4deck-manual-merge-e2e/{}", &suffix[..12]);
        let main = format!("//depot/{directory}/main.txt");
        let feature = format!("//depot/{directory}/feature.txt");
        let local_dir = root.join(&directory);
        std::fs::create_dir_all(&local_dir).map_err(|error| error.to_string())?;
        let local_main = local_dir.join("main.txt");
        let local_feature = local_dir.join("feature.txt");

        let seed = create_numbered_change(changelists, context, "manual merge seed").await?;
        std::fs::write(&local_main, b"shared base\n").map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "add",
            vec!["-c".into(), seed.to_string(), main.clone()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-c".into(), seed.to_string()],
            None,
            OutputMode::Text,
        )
        .await?;

        let branch = create_numbered_change(changelists, context, "manual merge branch").await?;
        checked_run(
            runner,
            context,
            "integrate",
            vec![
                "-c".into(),
                branch.to_string(),
                main.clone(),
                feature.clone(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "resolve",
            vec!["-at".into(), feature.clone()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-c".into(), branch.to_string()],
            None,
            OutputMode::Text,
        )
        .await?;

        let yours_change =
            create_numbered_change(changelists, context, "manual merge yours").await?;
        checked_run(
            runner,
            context,
            "edit",
            vec!["-c".into(), yours_change.to_string(), main.clone()],
            None,
            OutputMode::Text,
        )
        .await?;
        std::fs::write(&local_main, b"workspace side\n").map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-c".into(), yours_change.to_string()],
            None,
            OutputMode::Text,
        )
        .await?;

        let theirs_change =
            create_numbered_change(changelists, context, "manual merge theirs").await?;
        checked_run(
            runner,
            context,
            "edit",
            vec!["-c".into(), theirs_change.to_string(), feature.clone()],
            None,
            OutputMode::Text,
        )
        .await?;
        std::fs::write(&local_feature, b"incoming side\n").map_err(|error| error.to_string())?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-c".into(), theirs_change.to_string()],
            None,
            OutputMode::Text,
        )
        .await?;

        let merge_change =
            create_numbered_change(changelists, context, "manual merge target").await?;
        checked_run(
            runner,
            context,
            "integrate",
            vec![
                "-c".into(),
                merge_change.to_string(),
                feature.clone(),
                main.clone(),
            ],
            None,
            OutputMode::Text,
        )
        .await?;
        let manual = workflows
            .open_manual_merge(
                ManualMergeOpenRequest {
                    depot_path: main.clone(),
                    operation_id: Some("manual-merge-e2e-open".into()),
                },
                None,
            )
            .await?;
        ensure(
            manual.base_source.revision > 0
                && manual.theirs_source.revision > 0
                && manual.base.contains("shared base")
                && manual.yours.contains("workspace side")
                && manual.theirs.contains("incoming side")
                && manual.unresolved_blocks == 1,
            format!("manual merge inputs were not authoritative: {manual:?}"),
        )?;
        let edited = "resolved by P4Deck manual merge\n".to_owned();
        let stale_validation = workflows.validate_manual_merge(ManualMergeValidateRequest {
            session_id: manual.session_id.clone(),
            result: edited.clone(),
            operation_id: Some("manual-merge-e2e-stale-validation".into()),
        })?;
        let original = std::fs::read(&local_main).map_err(|error| error.to_string())?;
        let original_permissions = std::fs::metadata(&local_main)
            .map_err(|error| error.to_string())?
            .permissions();
        std::fs::set_permissions(
            &local_main,
            crate::app::manual_merge::writable_permissions(&original_permissions),
        )
        .map_err(|error| error.to_string())?;
        std::fs::write(&local_main, b"external change\n").map_err(|error| error.to_string())?;
        let stale = workflows
            .confirm_manual_merge_save(
                ManualMergeSaveConfirmation {
                    token: stale_validation
                        .token
                        .ok_or("stale validation returned no token")?,
                    session_id: manual.session_id.clone(),
                    result_digest: stale_validation.result_digest,
                    operation_id: Some("manual-merge-e2e-stale-save".into()),
                },
                None,
            )
            .await;
        ensure(
            stale.is_err(),
            "external file change bypassed manual merge CAS",
        )?;
        std::fs::write(&local_main, original).map_err(|error| error.to_string())?;
        std::fs::set_permissions(&local_main, original_permissions)
            .map_err(|error| error.to_string())?;

        let manual = workflows
            .open_manual_merge(
                ManualMergeOpenRequest {
                    depot_path: main.clone(),
                    operation_id: Some("manual-merge-e2e-reopen".into()),
                },
                None,
            )
            .await?;

        let validation = workflows.validate_manual_merge(ManualMergeValidateRequest {
            session_id: manual.session_id.clone(),
            result: edited,
            operation_id: Some("manual-merge-e2e-validation".into()),
        })?;
        let confirmation = ManualMergeSaveConfirmation {
            token: validation
                .token
                .ok_or("manual validation returned no token")?,
            session_id: manual.session_id.clone(),
            result_digest: validation.result_digest,
            operation_id: Some("manual-merge-e2e-save".into()),
        };
        let saved = workflows
            .confirm_manual_merge_save(confirmation.clone(), None)
            .await?;
        ensure(
            saved.outcome == WorkflowOutcome::Succeeded
                && saved
                    .backup_path
                    .as_deref()
                    .is_some_and(|path| Path::new(path).exists())
                && std::fs::read_to_string(&local_main).map_err(|error| error.to_string())?
                    == "resolved by P4Deck manual merge\n",
            format!("manual merge save did not verify: {saved:?}"),
        )?;
        ensure(
            workflows
                .confirm_manual_merge_save(confirmation, None)
                .await
                .is_err(),
            "manual merge save token replay was accepted",
        )?;
        let resolved = workflows
            .confirm_manual_merge_resolve(
                ManualMergeResolveConfirmation {
                    token: saved
                        .resolve_token
                        .ok_or("manual save returned no resolve token")?,
                    session_id: manual.session_id,
                    result_digest: saved.result_digest,
                    acknowledge: true,
                    operation_id: Some("manual-merge-e2e-resolve".into()),
                },
                None,
            )
            .await;
        ensure(
            resolved.outcome == WorkflowOutcome::Succeeded,
            format!("edited result was not marked resolved: {resolved:?}"),
        )?;
        if let Some(backup) = saved.backup_path {
            let _ = std::fs::remove_file(backup);
        }
        checked_run(
            runner,
            context,
            "revert",
            vec![main.clone()],
            None,
            OutputMode::Text,
        )
        .await?;
        delete_empty_change(changelists, context, merge_change).await?;
        let cleanup = create_numbered_change(changelists, context, "manual merge cleanup").await?;
        checked_run(
            runner,
            context,
            "delete",
            vec!["-c".into(), cleanup.to_string(), main, feature],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "submit",
            vec!["-c".into(), cleanup.to_string()],
            None,
            OutputMode::Text,
        )
        .await?;
        let _ = std::fs::remove_dir_all(local_dir);
        Ok(())
    }

    async fn create_numbered_change(
        changelists: &ChangelistService,
        context: &P4Context,
        description: &str,
    ) -> Result<i64, String> {
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: None,
                    mutation: PendingChangeMutation::Create {
                        description: description.into(),
                        jobs: Vec::new(),
                    },
                },
                None,
            )
            .await?
            .created_change_id
            .ok_or_else(|| "numbered changelist creation returned no ID".into())
    }

    async fn move_to_change(
        changelists: &ChangelistService,
        context: &P4Context,
        change_id: i64,
        depot_path: &str,
    ) -> Result<(), String> {
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: None,
                    mutation: PendingChangeMutation::MoveFiles {
                        target_change_id: change_id,
                        depot_paths: vec![depot_path.into()],
                    },
                },
                None,
            )
            .await?;
        Ok(())
    }

    async fn delete_empty_change(
        changelists: &ChangelistService,
        context: &P4Context,
        change_id: i64,
    ) -> Result<(), String> {
        changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: None,
                    mutation: PendingChangeMutation::Delete { change_id },
                },
                None,
            )
            .await?;
        Ok(())
    }

    async fn setup_named_client(
        runner: &P4Runner,
        base: &P4Context,
        client: &str,
        root: &Path,
    ) -> Result<P4Context, String> {
        if root.exists() {
            std::fs::remove_dir_all(root).map_err(|error| error.to_string())?;
        }
        std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
        let mut context = base.clone();
        context.client = client.into();
        context.cwd = Some(root.to_string_lossy().into_owned());
        let spec = format!(
            "Client: {client}\nOwner: {FIXTURE_USER}\nRoot: {}\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nLineEnd: local\nView:\n\t//depot/... //{client}/...\n",
            root.to_string_lossy().replace('\\', "/")
        );
        checked_run(
            runner,
            &context,
            "client",
            vec!["-i".into()],
            Some(spec),
            OutputMode::Text,
        )
        .await?;
        Ok(context)
    }

    async fn cleanup_named_client(
        runner: &P4Runner,
        base: &P4Context,
        client: &str,
        root: &Path,
    ) -> Result<(), String> {
        let mut context = base.clone();
        context.client = client.into();
        context.cwd = Some(root.to_string_lossy().into_owned());
        let _ = checked_run(
            runner,
            &context,
            "revert",
            vec!["-w".into(), "//...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        delete_pending_for_client(runner, base, FIXTURE_USER, client).await;
        let deletion = checked_run(
            runner,
            base,
            "client",
            vec!["-d".into(), "-f".into(), client.into()],
            None,
            OutputMode::Text,
        )
        .await;
        if root.exists() {
            std::fs::remove_dir_all(root).map_err(|error| error.to_string())?;
        }
        deletion.map(|_| ())
    }

    async fn delete_pending_for_client(
        runner: &P4Runner,
        admin: &P4Context,
        user: &str,
        client: &str,
    ) {
        let Ok(changes) = checked_run(
            runner,
            admin,
            "changes",
            vec![
                "-s".into(),
                "pending".into(),
                "-u".into(),
                user.into(),
                "-c".into(),
                client.into(),
            ],
            None,
            OutputMode::JsonLines,
        )
        .await
        else {
            return;
        };
        for change_id in json_values(&changes).into_iter().filter_map(|value| {
            value
                .get("change")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok())
        }) {
            let _ = checked_run(
                runner,
                admin,
                "shelve",
                vec!["-d".into(), "-c".into(), change_id.to_string()],
                None,
                OutputMode::Text,
            )
            .await;
            let _ = checked_run(
                runner,
                admin,
                "change",
                vec!["-d".into(), "-f".into(), change_id.to_string()],
                None,
                OutputMode::Text,
            )
            .await;
        }
    }

    async fn exercise_submit_permission_blocker(
        runner: &Arc<P4Runner>,
        changelists: &ChangelistService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let original = checked_run(
            runner,
            context,
            "protect",
            vec!["-o".into()],
            None,
            OutputMode::Text,
        )
        .await?;
        let original = writable_protections(&stdout_text(&original))?;
        let restricted = format!(
            "Protections:\n\tsuper user {FIXTURE_USER} * //...\n\topen user {READ_ONLY_USER} * //depot/p4deck-submit-e2e/...\n"
        );
        checked_run(
            runner,
            context,
            "protect",
            vec!["-i".into()],
            Some(restricted),
            OutputMode::Text,
        )
        .await?;

        let readonly_root = root
            .parent()
            .ok_or("E2E workspace has no fixture parent")?
            .join("submit-readonly-workspace");
        let permission_context_root =
            std::env::temp_dir().join(format!("p4deck-submit-permission-{}", uuid::Uuid::new_v4()));
        let mut readonly = context.clone();
        readonly.user = READ_ONLY_USER.into();
        readonly.client = READ_ONLY_CLIENT.into();
        readonly.cwd = Some(readonly_root.to_string_lossy().into_owned());
        let scenario = async {
            let user_form = format!(
                "User: {READ_ONLY_USER}\nEmail: readonly@fixture.invalid\nFullName: P4Deck read-only fixture\n"
            );
            checked_run(
                runner,
                context,
                "user",
                vec!["-f".into(), "-i".into()],
                Some(user_form),
                OutputMode::Text,
            )
            .await?;
            fixture_passwd(
                context,
                Some(READ_ONLY_USER),
                "p4deck-readonly-initial\np4deck-readonly-initial\n".into(),
            )
            .await?;
            std::fs::create_dir_all(&readonly_root).map_err(|error| error.to_string())?;
            let client_form = format!(
                "Client: {READ_ONLY_CLIENT}\nOwner: {READ_ONLY_USER}\nRoot: {}\nOptions: noallwrite noclobber nocompress unlocked nomodtime normdir\nLineEnd: local\nView:\n\t//depot/... //{READ_ONLY_CLIENT}/...\n",
                readonly_root.to_string_lossy().replace('\\', "/")
            );
            checked_run(
                runner,
                context,
                "client",
                vec!["-i".into()],
                Some(client_form),
                OutputMode::Text,
            )
            .await?;
            fixture_passwd(
                &readonly,
                None,
                "p4deck-readonly-initial\np4deck-readonly-local\np4deck-readonly-local\n"
                    .into(),
            )
            .await?;
            let login = crate::p4::connection::ConnectionAdapter::execute(
                &readonly,
                crate::p4::connection::ConnectionOperation::Login,
                None,
                Some("p4deck-readonly-local"),
            )
            .await;
            ensure(
                login.state == ConnectionState::Connected,
                format!("read-only fixture login failed: {login:?}"),
            )?;
            let depot_path = "//depot/p4deck-submit-e2e/outdated.txt";
            checked_run(
                runner,
                &readonly,
                "sync",
                vec![depot_path.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            checked_run(
                runner,
                &readonly,
                "edit",
                vec![depot_path.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            let change_id =
                create_numbered_change(changelists, &readonly, "BE-003 permission denial").await?;
            move_to_change(changelists, &readonly, change_id, depot_path).await?;

            let contexts = Arc::new(
                ContextStore::load(&permission_context_root)
                    .map_err(|error| error.to_string())?,
            );
            contexts
                .save(readonly.clone())
                .map_err(|error| error.to_string())?;
            let cache = Arc::new(StatusCache::new(15_000, 64, 2 * 1024 * 1024));
            let permission_submit = SubmitService::new(
                SubmitRepository::new(runner.clone()),
                contexts.clone(),
                cache.clone(),
            );
            let preflight = permission_submit
                .preflight(SubmitPreflightRequest { change_id }, None)
                .await;
            ensure(
                has_blocker(
                    &preflight,
                    crate::domain::SubmitIssueCode::PermissionDenied,
                ) && preflight.token.is_none(),
                format!("write permission denial was not blocked: {preflight:?}"),
            )?;
            let locked_branch_form = format!(
                "Branch: p4deck-e2e-permission-map\nOwner: {}\nDescription:\n\tlocked non-owner deletion fixture\nOptions: locked\nView:\n\t//depot/p4deck-submit-e2e/... //depot/p4deck-branch-permission/...\n",
                context.user
            );
            checked_run(
                runner,
                context,
                "branch",
                vec!["-i".into()],
                Some(locked_branch_form),
                OutputMode::Text,
            )
            .await?;
            let permission_branch = BranchMappingService::new(runner.clone(), contexts.clone());
            let branch_permission = permission_branch
                .preflight(
                    BranchMutationPreflightRequest {
                        mode: BranchMutationMode::Delete,
                        name: "p4deck-e2e-permission-map".into(),
                        desired: None,
                        operation_id: Some("branch-e2e-permission-preflight".into()),
                    },
                    None,
                )
                .await;
            ensure(
                !branch_permission.ready
                    && branch_permission.token.is_none()
                    && branch_permission
                        .blockers
                        .iter()
                        .any(|issue| issue.code == BranchIssueCode::OwnerMismatch),
                format!(
                    "Branch Mapping non-owner deletion was not blocked: {branch_permission:?}"
                ),
            )?;
            let permission_workflow = WorkflowService::new(
                WorkflowRepository::new(runner.clone()),
                contexts,
                cache,
            );
            let shelf_permission = permission_workflow
                .preflight_shelf(
                    ShelfPreflightRequest {
                        change_id,
                        depot_paths: vec![depot_path.into()],
                        mode: ShelfMode::CreateOrUpdate,
                        replace: false,
                    },
                    None,
                )
                .await;
            ensure(
                shelf_permission
                    .blockers
                    .iter()
                    .any(|item| item.code == WorkflowIssueCode::PermissionDenied)
                    && shelf_permission.token.is_none(),
                format!("shelf permission denial was not blocked: {shelf_permission:?}"),
            )?;
            checked_run(
                runner,
                &readonly,
                "revert",
                vec![depot_path.into()],
                None,
                OutputMode::Text,
            )
            .await?;
            delete_empty_change(changelists, &readonly, change_id).await
        }
        .await;

        let restore = checked_run(
            runner,
            context,
            "protect",
            vec!["-i".into()],
            Some(original),
            OutputMode::Text,
        )
        .await
        .map(|_| ());
        let _ = checked_run(
            runner,
            &readonly,
            "revert",
            vec!["-w".into(), "//...".into()],
            None,
            OutputMode::Text,
        )
        .await;
        delete_pending_for_client(runner, context, READ_ONLY_USER, READ_ONLY_CLIENT).await;
        let _ = checked_run(
            runner,
            context,
            "branch",
            vec!["-d".into(), "p4deck-e2e-permission-map".into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            runner,
            context,
            "client",
            vec!["-d".into(), "-f".into(), READ_ONLY_CLIENT.into()],
            None,
            OutputMode::Text,
        )
        .await;
        let _ = checked_run(
            runner,
            context,
            "user",
            vec!["-d".into(), "-f".into(), READ_ONLY_USER.into()],
            None,
            OutputMode::Text,
        )
        .await;
        if readonly_root.exists() {
            let _ = std::fs::remove_dir_all(&readonly_root);
        }
        if permission_context_root.exists() {
            let _ = std::fs::remove_dir_all(&permission_context_root);
        }
        match (scenario, restore) {
            (Err(error), Err(restore_error)) => Err(format!(
                "{error}; protections restore also failed: {restore_error}"
            )),
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    fn writable_protections(output: &str) -> Result<String, String> {
        let lines = output.lines().collect::<Vec<_>>();
        let start = lines
            .iter()
            .rposition(|line| line.trim() == "Protections:")
            .ok_or("p4 protect -o returned no Protections field")?;
        let body = lines[start + 1..]
            .iter()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.trim_start())
            .collect::<Vec<_>>();
        if body.is_empty() {
            return Err("p4 protect -o returned an empty Protections field".into());
        }
        Ok(format!(
            "Protections:\n{}\n",
            body.iter()
                .map(|line| format!("\t{line}"))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }

    fn pending_change(
        changes: &[crate::domain::PendingChange],
        id: i64,
    ) -> Result<&crate::domain::PendingChange, String> {
        changes
            .iter()
            .find(|change| change.id == id)
            .ok_or_else(|| format!("pending changelist {id} was not returned: {changes:?}"))
    }

    async fn ensure_state(
        files: &FileService,
        context: &P4Context,
        root: &Path,
        name: &str,
        expected: &str,
    ) -> Result<(), String> {
        let nodes = files
            .workspace_children(
                context.clone(),
                Some(root.join("main").to_string_lossy().into_owned()),
                false,
                None,
            )
            .await?;
        let actual = nodes
            .items
            .iter()
            .find(|node| node.name == name)
            .map(|node| node.state.as_str());
        ensure(
            actual == Some(expected),
            format!("{name} state was {actual:?}, expected {expected}"),
        )
    }

    async fn action(
        files: &FileService,
        context: &P4Context,
        action: FileAction,
        paths: Vec<String>,
    ) -> Result<(), String> {
        files
            .perform(
                context.clone(),
                FileActionRequest {
                    operation_id: None,
                    action,
                    paths,
                    revision: None,
                    states: None,
                    changelist_id: None,
                    file_type: None,
                    target_path: None,
                    resolve_method: None,
                    label: None,
                    revert_whole_changelist: false,
                    parallel_threads: None,
                },
                None,
            )
            .await?;
        Ok(())
    }

    fn sync_request(
        paths: Vec<String>,
        revision: Option<SyncRevisionSpec>,
        force: bool,
    ) -> SyncPreviewRequest {
        SyncPreviewRequest {
            paths,
            revision: revision.unwrap_or(SyncRevisionSpec {
                kind: SyncRevisionKind::Head,
                value: None,
            }),
            force,
            parallel_threads: None,
            operation_id: None,
        }
    }

    async fn confirmed_sync(
        sync: &SyncService,
        paths: Vec<String>,
        revision: Option<SyncRevisionSpec>,
    ) -> Result<crate::domain::SyncResult, String> {
        let preview = sync
            .preview(sync_request(paths, revision, false), None)
            .await;
        ensure(
            preview.ready && preview.token.is_some(),
            format!("sync preview was blocked: {preview:?}"),
        )?;
        let result = sync
            .confirm(
                SyncConfirmRequest {
                    token: preview.token.expect("checked above"),
                    target: preview.target,
                    acknowledge_force: false,
                    operation_id: None,
                },
                None,
            )
            .await;
        ensure(
            result.outcome == SyncOutcome::Succeeded,
            format!("confirmed sync failed: {result:?}"),
        )?;
        Ok(result)
    }

    async fn checked_run(
        runner: &P4Runner,
        context: &P4Context,
        command: &str,
        args: Vec<String>,
        input: Option<String>,
        output_mode: OutputMode,
    ) -> Result<OperationResult, String> {
        let result = runner
            .run(
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::Read,
                    operation_id: None,
                    source: OperationSource::Gui,
                    command: command.into(),
                    args,
                    context: context.clone(),
                    output_mode,
                    timeout_ms: None,
                    input,
                },
                None,
            )
            .await
            .map_err(|error| error.to_string())?;
        if result.exit_code == 0 {
            Ok(result)
        } else {
            Err(format!(
                "p4 {command} failed ({}): {}",
                result.exit_code,
                event_text(&result)
            ))
        }
    }

    /// Test-only secret setup channel. Production authentication continues to use
    /// ConnectionAdapter; the generic runner must remain unable to execute passwd.
    async fn fixture_passwd(
        context: &P4Context,
        user: Option<&str>,
        mut secret_input: String,
    ) -> Result<(), String> {
        use std::process::Stdio;
        use tokio::{io::AsyncWriteExt, process::Command};

        let executable = context
            .executable
            .as_deref()
            .ok_or("fixture p4 executable is missing")?;
        let mut command = Command::new(executable);
        command.args(["-p", &context.server, "-u", &context.user]);
        if !context.client.is_empty() {
            command.args(["-c", &context.client]);
        }
        if let Some(cwd) = context.cwd.as_deref() {
            command.args(["-d", cwd]);
        }
        command
            .env_remove("P4PASSWD")
            .env_remove("P4TICKETS")
            .env_remove("P4TRUST");
        if let Some(path) = &context.tickets_path {
            command.env("P4TICKETS", path);
        }
        if let Some(path) = &context.trust_path {
            command.env("P4TRUST", path);
        }
        command
            .arg("passwd")
            .args(user)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| "fixture password setup could not start")?;
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(secret_input.as_bytes()).await.is_err()
                || stdin.shutdown().await.is_err()
            {
                secret_input.zeroize();
                return Err("fixture password setup input failed".into());
            }
        }
        secret_input.zeroize();
        let mut output =
            tokio::time::timeout(std::time::Duration::from_secs(20), child.wait_with_output())
                .await
                .map_err(|_| "fixture password setup timed out")?
                .map_err(|_| "fixture password setup failed")?;
        let success = output.status.success();
        output.stdout.zeroize();
        output.stderr.zeroize();
        if success {
            Ok(())
        } else {
            Err("fixture password setup was rejected".into())
        }
    }

    fn json_values(result: &OperationResult) -> Vec<Value> {
        result
            .events
            .iter()
            .filter_map(|event| event.message.as_deref())
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn event_text(result: &OperationResult) -> String {
        result
            .events
            .iter()
            .filter_map(|event| event.message.as_deref())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn stdout_text(result: &OperationResult) -> String {
        result
            .events
            .iter()
            .filter(|event| matches!(event.kind, crate::domain::EventKind::Stdout))
            .filter_map(|event| event.message.as_deref())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    }

    fn make_writable(path: &Path) -> Result<(), String> {
        let mut permissions = std::fs::metadata(path)
            .map_err(|error| error.to_string())?
            .permissions();
        #[cfg(windows)]
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(permissions.mode() | 0o200);
        }
        std::fs::set_permissions(path, permissions).map_err(|error| error.to_string())
    }

    fn ensure(condition: bool, message: impl Into<String>) -> Result<(), String> {
        condition.then_some(()).ok_or_else(|| message.into())
    }

    fn required(name: &str) -> Result<String, String> {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("{name} is required"))
    }

    fn required_path(name: &str, must_exist: bool) -> Result<PathBuf, String> {
        let path = PathBuf::from(required(name)?);
        if !path.is_absolute() {
            return Err(format!("{name} must be absolute: {}", path.display()));
        }
        if must_exist && !path.is_file() {
            return Err(format!("{name} does not name a file: {}", path.display()));
        }
        Ok(path)
    }
}
