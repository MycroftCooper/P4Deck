use super::{command, parser};
use crate::{
    domain::*,
    p4::{
        changelists::ChangelistRepository,
        runner::{MutationGuard, P4Runner},
    },
};
use std::{collections::BTreeSet, sync::Arc};
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionAssessment {
    Allowed,
    Denied(Vec<String>),
    Unknown,
}

pub struct SubmitInspection {
    pub change: Option<PendingChange>,
    pub facts: Vec<parser::SubmitFileFact>,
    pub missing_fact_paths: Vec<String>,
    pub permission: PermissionAssessment,
    pub missing_jobs: Vec<String>,
    pub job_check_unknown: bool,
    pub file_check_unknown: bool,
    pub operation_ids: Vec<String>,
}

pub struct SubmitExecution {
    pub operation: OperationResult,
    pub submitted_change_id: Option<i64>,
    pub diagnostic_text: String,
}

pub struct SubmitRepository {
    runner: Arc<P4Runner>,
    changelists: ChangelistRepository,
}

impl SubmitRepository {
    pub fn new(runner: Arc<P4Runner>) -> Self {
        Self {
            changelists: ChangelistRepository::new(runner.clone()),
            runner,
        }
    }

    pub async fn lock_mutations(&self, server: &str) -> MutationGuard {
        self.runner.lock_mutations(server).await
    }

    pub async fn inspect(
        &self,
        context: &P4Context,
        change_id: i64,
        operation_prefix: &str,
        app: Option<&AppHandle>,
    ) -> Result<SubmitInspection, String> {
        command::ensure_context(context)?;
        let changes = self.changelists.query_pending(context.clone(), app).await?;
        let Some(change) = changes.into_iter().find(|change| change.id == change_id) else {
            return Ok(SubmitInspection {
                change: None,
                facts: Vec::new(),
                missing_fact_paths: Vec::new(),
                permission: PermissionAssessment::Unknown,
                missing_jobs: Vec::new(),
                job_check_unknown: false,
                file_check_unknown: false,
                operation_ids: Vec::new(),
            });
        };
        let paths = change
            .files
            .iter()
            .map(|file| file.depot_path.clone())
            .collect::<Vec<_>>();
        let mut operation_ids = Vec::new();
        let mut facts = Vec::new();
        let mut file_check_unknown = false;
        let mut permission = PermissionAssessment::Unknown;

        if !paths.is_empty() {
            let operation_id = format!("{operation_prefix}-files");
            operation_ids.push(operation_id.clone());
            match self
                .run(
                    context,
                    command::fstat(&paths)?,
                    Some(operation_id.clone()),
                    Some(paths.len()),
                    app,
                )
                .await
            {
                Ok(result) => facts = parser::file_facts(&result.events),
                Err(_) => file_check_unknown = true,
            }

            let operation_id = format!("{operation_prefix}-permissions");
            operation_ids.push(operation_id.clone());
            if let Ok(result) = self
                .run(
                    context,
                    command::protects(&paths)?,
                    Some(operation_id.clone()),
                    None,
                    app,
                )
                .await
            {
                permission = assess_permissions(&paths, parser::permissions(&result.events));
            }
        }

        let fact_paths = facts
            .iter()
            .map(|fact| fact.depot_path.as_str())
            .collect::<BTreeSet<_>>();
        let missing_fact_paths = paths
            .iter()
            .filter(|path| !fact_paths.contains(path.as_str()))
            .cloned()
            .collect();

        let mut missing_jobs = Vec::new();
        let mut job_check_unknown = false;
        for (index, job) in change.jobs.iter().enumerate() {
            let operation_id = format!("{operation_prefix}-job-{index}");
            operation_ids.push(operation_id.clone());
            match self
                .run(
                    context,
                    command::job(job)?,
                    Some(operation_id.clone()),
                    None,
                    app,
                )
                .await
            {
                Ok(result) => {
                    if !parser::job_ids(&result.events)
                        .iter()
                        .any(|candidate| candidate == job)
                    {
                        missing_jobs.push(job.clone());
                    }
                }
                Err(_) => job_check_unknown = true,
            }
        }

        Ok(SubmitInspection {
            change: Some(change),
            facts,
            missing_fact_paths,
            permission,
            missing_jobs,
            job_check_unknown,
            file_check_unknown,
            operation_ids,
        })
    }

    pub async fn submit(
        &self,
        context: &P4Context,
        change_id: i64,
        operation_id: String,
        file_count: usize,
        guard: &MutationGuard,
        app: Option<&AppHandle>,
    ) -> Result<SubmitExecution, String> {
        let invocation = command::submit(change_id)?;
        let result = self
            .runner
            .run_with_mutation_guard(
                P4CommandRequest {
                    // `p4 submit` uploads an entire changelist: a mutation
                    // whose payload can be large.
                    bound: crate::p4::bounds::IoBound::Command,
                    operation_id: Some(operation_id),
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: None,
                },
                app,
                Some(file_count.max(1)),
                guard,
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(SubmitExecution {
            submitted_change_id: parser::submitted_change_id(&result),
            diagnostic_text: event_text(&result),
            operation: result,
        })
    }

    async fn run(
        &self,
        context: &P4Context,
        invocation: command::SubmitInvocation,
        operation_id: Option<String>,
        progress_total: Option<usize>,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        let result = self
            .run_raw(context, invocation, operation_id, progress_total, app)
            .await?;
        if result.exit_code == 0 {
            Ok(result)
        } else {
            Err(event_text(&result))
        }
    }

    async fn run_raw(
        &self,
        context: &P4Context,
        invocation: command::SubmitInvocation,
        operation_id: Option<String>,
        progress_total: Option<usize>,
        app: Option<&AppHandle>,
    ) -> Result<OperationResult, String> {
        self.runner
            .run_with_progress(
                P4CommandRequest {
                    bound: crate::p4::bounds::IoBound::Command,
                    operation_id,
                    source: OperationSource::Gui,
                    command: invocation.command.into(),
                    args: invocation.args,
                    context: context.clone(),
                    output_mode: OutputMode::JsonLines,
                    timeout_ms: None,
                    input: None,
                },
                app,
                progress_total,
                invocation.argument_input,
            )
            .await
            .map_err(|error| error.to_string())
    }
}

fn assess_permissions(
    paths: &[String],
    facts: Vec<parser::PermissionFact>,
) -> PermissionAssessment {
    if facts.is_empty() {
        return PermissionAssessment::Unknown;
    }
    let requested = paths.iter().cloned().collect::<BTreeSet<_>>();
    let mut covered = BTreeSet::new();
    let mut denied = BTreeSet::new();
    let mut universal_allow = false;
    for fact in facts {
        let allowed = allows_submit(&fact.permission);
        match fact.depot_path {
            Some(path) if allowed => {
                covered.insert(path);
            }
            Some(path) => {
                denied.insert(path);
            }
            None if allowed => universal_allow = true,
            None => denied.extend(requested.iter().cloned()),
        }
    }
    if !denied.is_empty() {
        PermissionAssessment::Denied(denied.into_iter().collect())
    } else if universal_allow || requested.is_subset(&covered) {
        PermissionAssessment::Allowed
    } else {
        PermissionAssessment::Unknown
    }
}

fn allows_submit(permission: &str) -> bool {
    matches!(
        permission
            .trim_start_matches('=')
            .to_ascii_lowercase()
            .as_str(),
        "write" | "admin" | "super"
    )
}

fn event_text(result: &OperationResult) -> String {
    result
        .events
        .iter()
        .filter_map(|event| event.message.as_deref())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_assessment_is_conservative() {
        let paths = vec!["//depot/a".into()];
        assert_eq!(
            assess_permissions(
                &paths,
                vec![parser::PermissionFact {
                    depot_path: None,
                    permission: "read".into(),
                }]
            ),
            PermissionAssessment::Denied(paths.clone())
        );
        assert_eq!(
            assess_permissions(&paths, Vec::new()),
            PermissionAssessment::Unknown
        );
        assert_eq!(
            assess_permissions(
                &["//depot/a".into(), "//depot/b".into()],
                vec![parser::PermissionFact {
                    depot_path: Some("//depot/a".into()),
                    permission: "write".into(),
                }]
            ),
            PermissionAssessment::Unknown
        );
    }
}
