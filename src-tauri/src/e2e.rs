#[cfg(test)]
mod tests {
    use crate::{
        app::{
            changelist_service::ChangelistService, connection_service::ConnectionService,
            file_service::FileService, status_cache::StatusCache,
        },
        domain::{
            ConnectionState, FileAction, FileActionRequest, OperationResult, OperationSource,
            OutputMode, P4CommandRequest, P4Context, PendingChangeMutation,
            PendingChangeMutationRequest,
        },
        p4::{
            changelists::ChangelistRepository, context::ContextStore, runner::P4Runner, workspaces,
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
        let connection = Arc::new(ConnectionService::new(contexts));
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
        runner: &P4Runner,
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
        runner: &P4Runner,
        files: &FileService,
        changelists: &ChangelistService,
        journal: &OperationJournal,
        context: &P4Context,
        root: &Path,
    ) -> Result<(), String> {
        let status = connection.test_connection(context.clone()).await;
        ensure(
            status.state == ConnectionState::Connected,
            format!("typed connection state was {:?}", status.state),
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
