//! Mustang CLI validation (spec 3.7.1, FR-15, FR-16, FR-82).
//!
//! [`evaluate_report`] turns a Mustang stdout report plus exit code into a
//! [`Validation`] (steps 4-11). [`Mustang::validate`] runs the CLI (steps 1-3)
//! behind a semaphore of `MUSTANG_MAX_PARALLEL` permits.
//!
//! When `MUSTANG_MODE=daemon` the pool holds `MUSTANG_MAX_PARALLEL` long-running
//! JVM processes (started once at startup); each request sends a temp-file path
//! over stdin and reads the report over stdout, avoiding per-check JVM startup.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, Semaphore};

/// Upper bound for the stdout report we read from Mustang.
const MAX_STDOUT_BYTES: u64 = 32 * 1024 * 1024;

/// `MUSTANG_MODE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MustangMode {
    Cli,
    Off,
    MockValid,
    /// Long-running JVM daemon pool; avoids per-check JVM startup cost.
    Daemon,
}

impl std::str::FromStr for MustangMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "cli" => Ok(Self::Cli),
            "off" => Ok(Self::Off),
            "mock_valid" => Ok(Self::MockValid),
            "daemon" => Ok(Self::Daemon),
            other => Err(format!(
                "MUSTANG_MODE must be cli, off, mock_valid or daemon, got {other:?}"
            )),
        }
    }
}

/// Mustang settings from the environment (spec 6.1).
#[derive(Debug, Clone)]
pub struct MustangSettings {
    pub mode: MustangMode,
    /// `JAVA_BIN`
    pub java_bin: PathBuf,
    /// `MUSTANG_JAR`
    pub jar: PathBuf,
    /// `MUSTANG_RULE_WHITELIST`
    pub whitelist: Vec<String>,
    /// `MUSTANG_TIMEOUT_MS`
    pub timeout_ms: u64,
    /// `MUSTANG_MAX_PARALLEL` (values below 1 are treated as 1)
    pub max_parallel: usize,
}

/// `invoice.validation.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationStatus {
    Valid,
    Invalid,
    Unavailable,
    Off,
}

/// Result of a Mustang validation (`invoice.validation` without `tool`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Validation {
    pub status: ValidationStatus,
    pub tool_version: Option<String>,
    /// Number of non-whitelisted `error` elements.
    pub errors: usize,
    /// Non-whitelisted rule IDs, unique, in report order.
    pub error_rules: Vec<String>,
    /// Whitelisted rule IDs that occurred, unique, in report order.
    pub whitelisted_rules: Vec<String>,
}

impl Validation {
    fn with_status(status: ValidationStatus, tool_version: Option<String>) -> Self {
        Self {
            status,
            tool_version,
            errors: 0,
            error_rules: Vec::new(),
            whitelisted_rules: Vec::new(),
        }
    }

    fn unavailable_result() -> Self {
        Self::with_status(ValidationStatus::Unavailable, None)
    }

    /// KO-1 codes `MUSTANG:<rule>` (empty unless status is `invalid`).
    pub fn ko1_codes(&self) -> Vec<String> {
        if self.status != ValidationStatus::Invalid {
            return Vec::new();
        }
        self.error_rules
            .iter()
            .map(|r| format!("MUSTANG:{r}"))
            .collect()
    }

    /// True when `MUSTANG_UNAVAILABLE` belongs in `checks_incomplete`
    /// (status `unavailable` or `off`, FR-16).
    pub fn unavailable(&self) -> bool {
        matches!(
            self.status,
            ValidationStatus::Unavailable | ValidationStatus::Off
        )
    }
}

fn re_id() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[ID ([A-Za-z0-9_.-]+)\]").expect("valid regex"))
}

fn re_leading() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*\[([A-Za-z0-9_.-]+)\]").expect("valid regex"))
}

/// Rule ID of one `error` element (step 8).
fn rule_id(node: roxmltree::Node<'_, '_>) -> String {
    let text: String = node
        .descendants()
        .filter(|n| n.is_text())
        .filter_map(|n| n.text())
        .collect();
    if let Some(c) = re_id().captures(&text) {
        return c[1].to_string();
    }
    if let Some(c) = re_leading().captures(&text) {
        return c[1].to_string();
    }
    match node.attribute("type").map(str::trim) {
        Some(t) if !t.is_empty() => format!("TYPE-{t}"),
        _ => "UNSPECIFIED".to_string(),
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

/// Evaluate a Mustang report (spec 3.7.1 steps 4-11).
pub fn evaluate_report(stdout: &str, exit_code: i32, whitelist: &[String]) -> Validation {
    // Step 4: exit code.
    if exit_code != 0 && exit_code != 255 {
        return Validation::unavailable_result();
    }

    // Step 5: slice first `<validation` .. last `</validation>` and parse.
    const END: &str = "</validation>";
    let (Some(start), Some(end)) = (stdout.find("<validation"), stdout.rfind(END)) else {
        return Validation::unavailable_result();
    };
    let end = end + END.len();
    if end <= start {
        return Validation::unavailable_result();
    }
    let opts = roxmltree::ParsingOptions {
        allow_dtd: false,
        nodes_limit: 200_000,
        ..Default::default()
    };
    let Ok(doc) = roxmltree::Document::parse_with_options(&stdout[start..end], opts) else {
        return Validation::unavailable_result();
    };
    let root = doc.root_element();

    // Step 11 (part): tool version from validator/@version.
    let tool_version = root
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "validator")
        .find_map(|n| n.attribute("version"))
        .map(str::to_string);

    // Step 6: any exception → unavailable.
    if root
        .descendants()
        .any(|n| n.is_element() && n.tag_name().name() == "exception")
    {
        return Validation::with_status(ValidationStatus::Unavailable, tool_version);
    }

    // Steps 7-9: errors, rule IDs, whitelist.
    let mut errors = 0usize;
    let mut error_rules = Vec::new();
    let mut whitelisted_rules = Vec::new();
    for node in root
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "error")
    {
        let rule = rule_id(node);
        if whitelist.iter().any(|w| w.trim() == rule) {
            push_unique(&mut whitelisted_rules, rule);
        } else {
            errors += 1;
            push_unique(&mut error_rules, rule);
        }
    }

    // Step 10: summary invalid without any error → UNSPECIFIED.
    let summary_invalid = root
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "summary")
        .any(|n| n.attribute("status") == Some("invalid"));
    if error_rules.is_empty() && whitelisted_rules.is_empty() && summary_invalid {
        error_rules.push("UNSPECIFIED".to_string());
    }

    let status = if error_rules.is_empty() {
        ValidationStatus::Valid
    } else {
        ValidationStatus::Invalid
    };
    Validation {
        status,
        tool_version,
        errors,
        error_rules,
        whitelisted_rules,
    }
}

// ---------------------------------------------------------------------------
// Daemon pool
// ---------------------------------------------------------------------------

/// One slot in the daemon pool: a long-running JVM process with open pipes.
struct DaemonSlot {
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    _child: tokio::process::Child,
}

impl DaemonSlot {
    /// Spawn one daemon process and wait for its "READY" signal.
    async fn spawn(settings: &MustangSettings) -> Option<Self> {
        let daemon_dir = settings.jar.parent()?;
        let classpath = format!("{}:{}", settings.jar.display(), daemon_dir.display());

        let mut child = tokio::process::Command::new(&settings.java_bin)
            .arg("-Xmx1G")
            .arg("-Dfile.encoding=UTF-8")
            .arg("-cp")
            .arg(&classpath)
            .arg("MustangDaemon")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| tracing::warn!(error = %e, "mustang daemon: spawn failed"))
            .ok()?;

        let stdin = child.stdin.take()?;
        let mut stdout = BufReader::new(child.stdout.take()?);

        // Wait up to 30 s for the JVM to initialise and print "READY".
        let ready = tokio::time::timeout(Duration::from_secs(30), async {
            let mut line = String::new();
            stdout.read_line(&mut line).await.ok()?;
            (line.trim() == "READY").then_some(())
        })
        .await;

        match ready {
            Ok(Some(())) => Some(Self { stdin, stdout, _child: child }),
            _ => {
                tracing::warn!("mustang daemon: process did not send READY in time");
                None
            }
        }
    }

    /// Send `path` to the daemon, read and return `(report, exit_code)`.
    /// Returns `None` on I/O error or protocol violation; the slot is then broken.
    async fn validate(&mut self, path: &str, timeout_ms: u64) -> Option<(String, i32)> {
        let request = format!("{path}\n");
        self.stdin
            .write_all(request.as_bytes())
            .await
            .map_err(|e| tracing::warn!(error = %e, "mustang daemon: stdin write failed"))
            .ok()?;
        self.stdin
            .flush()
            .await
            .map_err(|e| tracing::warn!(error = %e, "mustang daemon: stdin flush failed"))
            .ok()?;

        tokio::time::timeout(Duration::from_millis(timeout_ms), async {
            // Read "EXIT:<code>"
            let mut line = String::new();
            self.stdout.read_line(&mut line).await.ok()?;
            let code: i32 = line.trim().strip_prefix("EXIT:")?.parse().ok()?;

            // Read "LENGTH:<n>"
            line.clear();
            self.stdout.read_line(&mut line).await.ok()?;
            let len: usize = line.trim().strip_prefix("LENGTH:")?.parse().ok()?;

            if len == 0 {
                return Some((String::new(), code));
            }

            // Read exactly `len` bytes of report + trailing newline.
            let mut buf = vec![0u8; len + 1];
            self.stdout.read_exact(&mut buf).await.ok()?;
            buf.truncate(len);
            Some((String::from_utf8_lossy(&buf).into_owned(), code))
        })
        .await
        .map_err(|_| tracing::warn!(timeout_ms, "mustang daemon: validation timeout"))
        .ok()
        .flatten()
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Mustang runner with a process semaphore (FR-82).
pub struct Mustang {
    pub settings: MustangSettings,
    /// Counts available slots (Cli: fixed at max_parallel; Daemon: 1 per live process).
    semaphore: Semaphore,
    /// Non-empty only in Daemon mode; invariant: len == semaphore available permits.
    pool: Mutex<Vec<DaemonSlot>>,
}

impl Mustang {
    /// Builds the runner. In Daemon mode this spawns `max_parallel` JVM processes
    /// and waits for each to signal readiness; must be called from an async context.
    pub async fn new(settings: MustangSettings) -> Self {
        let n = settings.max_parallel.max(1);

        if settings.mode == MustangMode::Daemon {
            let mut slots = Vec::with_capacity(n);
            for _ in 0..n {
                if let Some(slot) = DaemonSlot::spawn(&settings).await {
                    slots.push(slot);
                } else {
                    tracing::warn!("mustang: daemon slot failed to start");
                }
            }
            let live = slots.len();
            if live == 0 {
                tracing::error!("mustang: all daemon slots failed — mode effectively unavailable");
            }
            return Self {
                settings,
                semaphore: Semaphore::new(live),
                pool: Mutex::new(slots),
            };
        }

        Self {
            settings,
            semaphore: Semaphore::new(n),
            pool: Mutex::new(Vec::new()),
        }
    }

    /// Validate an invoice XML according to the configured mode.
    pub async fn validate(&self, xml: &str) -> Validation {
        match self.settings.mode {
            MustangMode::Off => Validation::with_status(ValidationStatus::Off, None),
            MustangMode::MockValid => {
                Validation::with_status(ValidationStatus::Valid, Some("mock".to_string()))
            }
            MustangMode::Cli => {
                let Ok(_permit) = self.semaphore.acquire().await else {
                    return Validation::unavailable_result();
                };
                match self.run_cli(xml).await {
                    Some((stdout, code)) => {
                        evaluate_report(&stdout, code, &self.settings.whitelist)
                    }
                    None => Validation::unavailable_result(),
                }
            }
            MustangMode::Daemon => {
                let timeout = Duration::from_millis(self.settings.timeout_ms);
                let permit =
                    match tokio::time::timeout(timeout, self.semaphore.acquire()).await {
                        Ok(Ok(p)) => p,
                        _ => {
                            tracing::warn!("mustang daemon: semaphore acquire timed out");
                            return Validation::unavailable_result();
                        }
                    };

                let xml_stripped = xml.strip_prefix('\u{feff}').unwrap_or(xml);
                let path = match write_temp(xml_stripped) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(error = %e, "mustang daemon: temp file failed");
                        return Validation::unavailable_result();
                    }
                };
                let path_str = match path.to_str() {
                    Some(s) => s.to_owned(),
                    None => return Validation::unavailable_result(),
                };

                let mut slot = self.pool.lock().await.pop().expect("semaphore invariant");
                let result = slot.validate(&path_str, self.settings.timeout_ms).await;
                drop(path);

                match result {
                    Some((ref stdout, code)) => {
                        let validation =
                            evaluate_report(stdout, code, &self.settings.whitelist);
                        self.pool.lock().await.push(slot);
                        drop(permit);
                        validation
                    }
                    None => {
                        // Slot is broken; drop it and try to start a replacement.
                        drop(slot);
                        tracing::warn!("mustang daemon: slot died, spawning replacement");
                        if let Some(new_slot) = DaemonSlot::spawn(&self.settings).await {
                            self.pool.lock().await.push(new_slot);
                            // Restore the permit so the pool count stays consistent.
                            drop(permit);
                        }
                        // If spawn failed, permit is dropped without restoring → pool shrinks.
                        Validation::unavailable_result()
                    }
                }
            }
        }
    }

    /// Steps 1-3: temp file, process, timeout. Returns (stdout, exit code).
    /// The temp file is removed when `path` drops, on every return path.
    async fn run_cli(&self, xml: &str) -> Option<(String, i32)> {
        let xml = xml.strip_prefix('\u{feff}').unwrap_or(xml);
        let path = write_temp(xml)
            .map_err(|e| tracing::warn!(error = %e, "mustang: temp file failed"))
            .ok()?;

        let mut child = tokio::process::Command::new(&self.settings.java_bin)
            .arg("-Xmx1G")
            .arg("-Dfile.encoding=UTF-8")
            .arg("-jar")
            .arg(&self.settings.jar)
            .args(["--no-notices", "--action", "validate", "--source"])
            .arg(&*path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| tracing::warn!(error = %e, "mustang: spawn failed"))
            .ok()?;

        let mut stdout = child.stdout.take()?;
        let mut stderr = child.stderr.take()?;
        let timeout = Duration::from_millis(self.settings.timeout_ms);
        let result = tokio::time::timeout(timeout, async {
            let mut out = Vec::new();
            let mut limited = (&mut stdout).take(MAX_STDOUT_BYTES);
            let mut sink = tokio::io::sink();
            let (read_out, _, status) = tokio::join!(
                limited.read_to_end(&mut out),
                tokio::io::copy(&mut stderr, &mut sink),
                child.wait(),
            );
            read_out.ok()?;
            Some((out, status.ok()?))
        })
        .await;

        let (out, status) = match result {
            Ok(Some(done)) => done,
            Ok(None) => return None,
            Err(_) => {
                tracing::warn!(timeout_ms = self.settings.timeout_ms, "mustang: timeout");
                let _ = child.kill().await;
                return None;
            }
        };
        drop(path);

        let code = status.code()?;
        // Java's System.exit(-1) is 255 on Unix but -1 on Windows.
        let code = if cfg!(windows) && code == -1 {
            255
        } else {
            code
        };
        Some((String::from_utf8_lossy(&out).into_owned(), code))
    }
}

/// Write the XML to a private temp file; the returned path deletes it on drop.
fn write_temp(xml: &str) -> std::io::Result<tempfile::TempPath> {
    let mut file = tempfile::Builder::new()
        .prefix("sniffer-mustang-")
        .suffix(".xml")
        .tempfile()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = file
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(xml.as_bytes())?;
    file.flush()?;
    Ok(file.into_temp_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    const B1: &str = include_str!("../../docs/fixtures/mustang/b1.xml");
    const B2: &str = include_str!("../../docs/fixtures/mustang/b2.xml");
    const B3: &str = include_str!("../../docs/fixtures/mustang/b3.xml");
    const B4: &str = include_str!("../../docs/fixtures/mustang/b4.xml");

    fn wl(rules: &[&str]) -> Vec<String> {
        rules.iter().map(|s| s.to_string()).collect()
    }

    fn report(messages: &str, status: &str) -> String {
        format!(
            "<validation><xml><info><validator version=\"2.26.0\"/></info>\
             <messages>{messages}</messages><summary status=\"{status}\"/></xml>\
             <messages></messages><summary status=\"{status}\"/></validation>"
        )
    }

    // Test 36: B.1 valid.
    #[test]
    fn b1_valid() {
        let v = evaluate_report(B1, 0, &[]);
        assert_eq!(v.status, ValidationStatus::Valid);
        assert_eq!(v.tool_version.as_deref(), Some("2.26.0"));
        assert_eq!(v.errors, 0);
        assert!(v.error_rules.is_empty());
        assert!(v.ko1_codes().is_empty());
        assert!(!v.unavailable());
    }

    // Test 36: B.2 valid, warning BR-DE-19 ignored.
    #[test]
    fn b2_valid_warning_ignored() {
        let v = evaluate_report(B2, 0, &[]);
        assert_eq!(v.status, ValidationStatus::Valid);
        assert_eq!(v.errors, 0);
        assert!(v.ko1_codes().is_empty());
        assert!(!v.unavailable());
    }

    // Test 36: B.3 KO-1 MUSTANG:BR-DE-15.
    #[test]
    fn b3_invalid_br_de_15() {
        let v = evaluate_report(B3, 255, &[]);
        assert_eq!(v.status, ValidationStatus::Invalid);
        assert_eq!(v.tool_version.as_deref(), Some("2.26.0"));
        assert_eq!(v.errors, 1);
        assert_eq!(v.error_rules, wl(&["BR-DE-15"]));
        assert!(v.whitelisted_rules.is_empty());
        assert_eq!(v.ko1_codes(), wl(&["MUSTANG:BR-DE-15"]));
        assert!(!v.unavailable());
    }

    // Test 36: B.4 exception → MUSTANG_UNAVAILABLE.
    #[test]
    fn b4_exception_unavailable() {
        let v = evaluate_report(B4, 255, &[]);
        assert_eq!(v.status, ValidationStatus::Unavailable);
        assert!(v.unavailable());
        assert!(v.ko1_codes().is_empty());
    }

    #[test]
    fn b3_whitelisted() {
        let v = evaluate_report(B3, 255, &wl(&["BR-DE-15"]));
        assert_eq!(v.status, ValidationStatus::Valid);
        assert_eq!(v.errors, 0);
        assert!(v.error_rules.is_empty());
        assert_eq!(v.whitelisted_rules, wl(&["BR-DE-15"]));
        assert!(v.ko1_codes().is_empty());
        assert!(!v.unavailable());
    }

    #[test]
    fn unexpected_exit_code_unavailable() {
        assert!(evaluate_report(B1, 1, &[]).unavailable());
        assert!(evaluate_report(B3, -1, &[]).unavailable());
    }

    #[test]
    fn garbage_stdout_unavailable() {
        assert!(evaluate_report("", 0, &[]).unavailable());
        assert!(evaluate_report("Exception in thread main", 255, &[]).unavailable());
        assert!(evaluate_report("<validation><broken></validation>", 0, &[]).unavailable());
        assert!(evaluate_report("</validation><validation>", 0, &[]).unavailable());
    }

    #[test]
    fn log_noise_around_report_is_ignored() {
        let stdout = format!("INFO starting\n{B3}\ntrailing log line");
        let v = evaluate_report(&stdout, 255, &[]);
        assert_eq!(v.ko1_codes(), wl(&["MUSTANG:BR-DE-15"]));
    }

    #[test]
    fn rule_id_fallbacks_unique_in_order() {
        let r = report(
            "<error type=\"27\">[BR-CO-10] sum mismatch [ID BR-CO-10] from x</error>\
             <error type=\"27\">  [BR-01] leading only</error>\
             <error type=\"12\">no brackets here</error>\
             <error>nothing at all</error>\
             <error type=\"27\">[X] [ID BR-CO-10] again</error>\
             <warning type=\"27\">[ID BR-DE-19]</warning>\
             <notice>[ID N-1]</notice>",
            "invalid",
        );
        let v = evaluate_report(&r, 255, &[]);
        assert_eq!(v.status, ValidationStatus::Invalid);
        assert_eq!(v.errors, 5);
        assert_eq!(
            v.error_rules,
            wl(&["BR-CO-10", "BR-01", "TYPE-12", "UNSPECIFIED"])
        );
    }

    #[test]
    fn id_regex_wins_over_leading_bracket() {
        let r = report("<error>[LEAD] text [ID REAL-1] from</error>", "invalid");
        assert_eq!(evaluate_report(&r, 255, &[]).error_rules, wl(&["REAL-1"]));
    }

    #[test]
    fn summary_invalid_without_errors_is_unspecified() {
        let r = report("", "invalid");
        let v = evaluate_report(&r, 255, &[]);
        assert_eq!(v.status, ValidationStatus::Invalid);
        assert_eq!(v.ko1_codes(), wl(&["MUSTANG:UNSPECIFIED"]));
    }

    #[test]
    fn partial_whitelist_keeps_other_errors() {
        let r = report(
            "<error>[ID BR-DE-15]</error><error>[ID BR-01]</error><error>[ID BR-DE-15]</error>",
            "invalid",
        );
        let v = evaluate_report(&r, 255, &wl(&["BR-DE-15"]));
        assert_eq!(v.errors, 1);
        assert_eq!(v.error_rules, wl(&["BR-01"]));
        assert_eq!(v.whitelisted_rules, wl(&["BR-DE-15"]));
    }

    fn settings(mode: MustangMode) -> MustangSettings {
        MustangSettings {
            mode,
            java_bin: "java".into(),
            jar: "missing.jar".into(),
            whitelist: Vec::new(),
            timeout_ms: 20_000,
            max_parallel: 2,
        }
    }

    #[tokio::test]
    async fn mode_off() {
        let v = Mustang::new(settings(MustangMode::Off))
            .await
            .validate("<x/>")
            .await;
        assert_eq!(v.status, ValidationStatus::Off);
        assert!(v.unavailable());
        assert!(v.ko1_codes().is_empty());
    }

    #[tokio::test]
    async fn mode_mock_valid() {
        let v = Mustang::new(settings(MustangMode::MockValid))
            .await
            .validate("<x/>")
            .await;
        assert_eq!(v.status, ValidationStatus::Valid);
        assert_eq!(v.tool_version.as_deref(), Some("mock"));
        assert_eq!(v.errors, 0);
        assert!(!v.unavailable());
    }

    #[tokio::test]
    async fn cli_spawn_failure_unavailable() {
        let mut s = settings(MustangMode::Cli);
        s.java_bin = "sniffer-no-such-java-binary".into();
        let v = Mustang::new(s).await.validate("<x/>").await;
        assert_eq!(v.status, ValidationStatus::Unavailable);
    }

    #[test]
    fn mode_from_str() {
        assert_eq!("cli".parse::<MustangMode>(), Ok(MustangMode::Cli));
        assert_eq!("off".parse::<MustangMode>(), Ok(MustangMode::Off));
        assert_eq!(
            "mock_valid".parse::<MustangMode>(),
            Ok(MustangMode::MockValid)
        );
        assert_eq!("daemon".parse::<MustangMode>(), Ok(MustangMode::Daemon));
        assert!("CLI".parse::<MustangMode>().is_err());
    }

    // Tests 22/23: real Mustang CLI. Run with
    // SNIFFER_TEST_MUSTANG=1 MUSTANG_JAR=<jar> cargo test mustang -- --ignored
    const F1: &str = include_str!("../../docs/fixtures/f1.xml");

    fn cli_settings(whitelist: &[&str]) -> Option<MustangSettings> {
        if std::env::var("SNIFFER_TEST_MUSTANG").ok().as_deref() != Some("1") {
            eprintln!("skipped: SNIFFER_TEST_MUSTANG != 1");
            return None;
        }
        let Some(jar) = std::env::var_os("MUSTANG_JAR") else {
            eprintln!("skipped: MUSTANG_JAR not set");
            return None;
        };
        Some(MustangSettings {
            mode: MustangMode::Cli,
            java_bin: std::env::var_os("JAVA_BIN")
                .unwrap_or_else(|| "java".into())
                .into(),
            jar: jar.into(),
            whitelist: wl(whitelist),
            timeout_ms: 60_000,
            max_parallel: 2,
        })
    }

    fn f1_without_buyer_reference() -> String {
        let re = Regex::new(r"[ \t]*<ram:BuyerReference>[^<]*</ram:BuyerReference>\r?\n?")
            .expect("valid regex");
        let out = re.replace(F1, "").into_owned();
        assert_ne!(out, F1, "F1 must contain BuyerReference");
        out
    }

    #[tokio::test]
    #[ignore]
    async fn cli_f1_valid() {
        let Some(s) = cli_settings(&[]) else { return };
        let v = Mustang::new(s).await.validate(F1).await;
        assert_eq!(v.status, ValidationStatus::Valid, "{v:?}");
        assert_eq!(v.tool_version.as_deref(), Some("2.26.0"));
    }

    // Test 22: F1 without BuyerReference → KO-1 MUSTANG:BR-DE-15.
    #[tokio::test]
    #[ignore]
    async fn cli_test22_missing_buyer_reference() {
        let Some(s) = cli_settings(&[]) else { return };
        let v = Mustang::new(s)
            .await
            .validate(&f1_without_buyer_reference())
            .await;
        assert_eq!(v.status, ValidationStatus::Invalid, "{v:?}");
        assert_eq!(v.ko1_codes(), wl(&["MUSTANG:BR-DE-15"]));
    }

    // Test 23: as 22 with MUSTANG_RULE_WHITELIST=BR-DE-15 → no KO codes.
    #[tokio::test]
    #[ignore]
    async fn cli_test23_whitelisted_buyer_reference() {
        let Some(s) = cli_settings(&["BR-DE-15"]) else {
            return;
        };
        let v = Mustang::new(s)
            .await
            .validate(&f1_without_buyer_reference())
            .await;
        assert_eq!(v.status, ValidationStatus::Valid, "{v:?}");
        assert!(v.ko1_codes().is_empty());
        assert_eq!(v.whitelisted_rules, wl(&["BR-DE-15"]));
    }
}
