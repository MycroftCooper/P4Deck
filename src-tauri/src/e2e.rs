#[cfg(test)]
mod tests {
    use crate::{
        app::{
            changelist_service::ChangelistService, connection_service::ConnectionService,
            file_service::FileService, status_cache::StatusCache, submit_service::SubmitService,
            workflow_service::WorkflowService,
        },
        domain::{
            AuthenticationRequest, ConnectionState, FileAction, FileActionRequest, LoginRequest,
            OperationResult, OperationSource, OutputMode, P4CommandRequest, P4Context,
            PendingChangeMutation, PendingChangeMutationRequest, ResolveConfirmation,
            ResolvePreflightRequest, ResolveSelection, ResolveStrategy, ShelfMode,
            ShelfPreflightRequest, SubmitConfirmation, SubmitFailureCode, SubmitOutcome,
            SubmitPreflightRequest, UnshelvePreflightRequest, WorkflowConfirmation,
            WorkflowFailureCode, WorkflowIssueCode, WorkflowOutcome,
        },
        p4::{
            changelists::ChangelistRepository, context::ContextStore, runner::P4Runner,
            submit::SubmitRepository, workflows::WorkflowRepository, workspaces,
        },
        persistence::{
            log_store::LogStore,
            operation_journal::{JournalState, OperationJournal},
        },
    };
    use serde_json::Value;
    use std::{
        net::SocketAddr,
        path::{Path, PathBuf},
        sync::Arc,
    };

    const FIXTURE_SERVER: &str = "127.0.0.1:16661";
    const FIXTURE_USER: &str = "p4deck-fixture-admin";
    const E2E_CLIENT: &str = "p4deck-fixture-e2e";
    const WRITER_CLIENT: &str = "p4deck-fixture-submit-writer";
    const READ_ONLY_CLIENT: &str = "p4deck-fixture-submit-readonly";
    const READ_ONLY_USER: &str = "p4deck-fixture-readonly";
    const FIXTURE_SERVER_ID: &str = "p4deck-fixture-local";
    const E2E_JOB: &str = "P4DECK-E2E-JOB";

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
                },
                workspace_root,
                runtime_root,
            })
        }
    }

    async fn run_fixture_case(config: FixtureConfig) -> Result<(), String> {
        std::fs::create_dir_all(&config.runtime_root).map_err(|error| error.to_string())?;
        let contexts = Arc::new(ContextStore::load(&config.runtime_root));
        let connection = Arc::new(ConnectionService::new(contexts.clone()));
        let context = connection.save(config.context.clone())?;

        let logs = Arc::new(LogStore::open(&config.runtime_root.join("logs.sqlite"))?);
        let journal = Arc::new(OperationJournal::open(
            &config.runtime_root.join("operations.sqlite"),
        )?);
        let runner = Arc::new(P4Runner::new(logs.clone(), journal.clone()));
        let status_cache = Arc::new(StatusCache::new(15_000, 512, 16 * 1024 * 1024));
        let changelists = ChangelistService::new(
            ChangelistRepository::new(runner.clone()),
            status_cache.clone(),
        );
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
        let files = FileService::new(runner.clone(), status_cache, journal.clone());

        let _ = cleanup_client(&runner, &context, &config.workspace_root).await;
        let setup = setup_client(&runner, &context, &config.workspace_root).await;
        let scenario = match setup {
            Ok(()) => {
                exercise_services(
                    &connection,
                    &runner,
                    &files,
                    &changelists,
                    &journal,
                    &logs,
                    &submit,
                    &expiring_submit,
                    &contexts,
                    &workflows,
                    &expiring_workflows,
                    &context,
                    &config.workspace_root,
                )
                .await
            }
            Err(error) => Err(error),
        };
        let cleanup = cleanup_client(&runner, &context, &config.workspace_root).await;

        drop(files);
        drop(runner);
        drop(logs);
        drop(journal);
        drop(connection);

        match (scenario, cleanup) {
            (Err(error), Err(cleanup_error)) => {
                Err(format!("{error}; cleanup also failed: {cleanup_error}"))
            }
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(format!("cleanup failed: {error}")),
            (Ok(()), Ok(())) => Ok(()),
        }
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

    async fn exercise_services(
        connection: &ConnectionService,
        runner: &Arc<P4Runner>,
        files: &FileService,
        changelists: &ChangelistService,
        journal: &OperationJournal,
        logs: &LogStore,
        submit: &SubmitService,
        expiring_submit: &SubmitService,
        contexts: &ContextStore,
        workflows: &WorkflowService,
        expiring_workflows: &WorkflowService,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
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
        action(
            files,
            context,
            FileAction::GetLatest,
            vec!["//depot/main/README.txt".into()],
        )
        .await?;
        ensure(
            baseline.is_file(),
            "Sync did not materialize the seed README",
        )?;
        let main = files
            .workspace_children(
                context.clone(),
                Some(root.join("main").to_string_lossy().into_owned()),
                None,
            )
            .await?;
        ensure(
            main.iter().any(|node| {
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
        exercise_pending_changelists(changelists, journal, runner, files, context, root).await?;
        exercise_shelf_unshelve_resolve(
            runner,
            changelists,
            workflows,
            expiring_workflows,
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
        exercise_submit_blockers(runner, changelists, submit, files, context, root).await?;
        exercise_submit_permission_blocker(runner, changelists, context, root).await?;
        Ok(())
    }

    async fn exercise_pending_changelists(
        changelists: &ChangelistService,
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

        let moved = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-move-numbered".into()),
                    mutation: PendingChangeMutation::MoveFiles {
                        target_change_id: change_id,
                        depot_paths: vec!["//depot/main/README.txt".into()],
                    },
                },
                None,
            )
            .await?;
        ensure(
            pending_change(&moved.refreshed_changes, change_id)?
                .files
                .iter()
                .any(|file| file.depot_path == "//depot/main/README.txt"),
            "numbered changelist did not receive the moved file",
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

        let moved_default = changelists
            .mutate_pending(
                context.clone(),
                PendingChangeMutationRequest {
                    operation_id: Some("be004-move-default".into()),
                    mutation: PendingChangeMutation::MoveFiles {
                        target_change_id: 0,
                        depot_paths: vec!["//depot/main/README.txt".into()],
                    },
                },
                None,
            )
            .await?;
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
        contexts.save(other_workspace)?;
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
        contexts.save(context.clone())?;
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

    async fn exercise_submit_blockers(
        runner: &Arc<P4Runner>,
        changelists: &ChangelistService,
        submit: &SubmitService,
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
            action(
                files,
                context,
                FileAction::GetLatest,
                vec![outdated_depot.clone()],
            )
            .await?;
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
        changelists: &ChangelistService,
        workflows: &WorkflowService,
        expiring_workflows: &WorkflowService,
        contexts: &ContextStore,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
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
            vec!["-t".into(), "binary".into(), A.into(), B.into()],
            None,
            OutputMode::Text,
        )
        .await?;
        checked_run(
            runner,
            context,
            "reopen",
            vec!["-t".into(), "binary".into(), A.into(), B.into()],
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

        contexts.save(target_context.clone())?;
        let resolve = workflows
            .preflight_resolve(
                ResolvePreflightRequest {
                    depot_paths: vec![B.into()],
                },
                None,
            )
            .await;
        ensure(
            resolve.ready && resolve.conflicts[0].status == "unresolved",
            format!("real resolve conflict was not exposed: {resolve:?}"),
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
                },
                None,
            )
            .await;
        ensure(
            !no_conflict.ready && no_conflict.conflicts[0].status != "unresolved",
            format!("non-conflict was falsely advertised as resolvable: {no_conflict:?}"),
        )?;
        contexts.save(context.clone())?;

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
            checked_run(
                runner,
                context,
                "passwd",
                vec![READ_ONLY_USER.into()],
                Some("p4deck-readonly-initial\np4deck-readonly-initial\n".into()),
                OutputMode::Text,
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
            checked_run(
                runner,
                &readonly,
                "passwd",
                Vec::new(),
                Some(
                    "p4deck-readonly-initial\np4deck-readonly-local\np4deck-readonly-local\n"
                        .into(),
                ),
                OutputMode::Text,
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

            let contexts = Arc::new(ContextStore::load(&permission_context_root));
            contexts.save(readonly.clone())?;
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
                None,
            )
            .await?;
        let actual = nodes
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
                    parallel_threads: None,
                },
                None,
            )
            .await?;
        Ok(())
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
                    operation_id: None,
                    source: OperationSource::Gui,
                    command: command.into(),
                    args,
                    context: context.clone(),
                    output_mode,
                    timeout_ms: Some(60_000),
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
