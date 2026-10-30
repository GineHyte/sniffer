use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use tracing_subscriber::EnvFilter;

/// Invoice Scam Sniffer – Initial Check (spec v1.0).
#[derive(Debug, Parser)]
#[command(name = "sniffer", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

/// CLI commands per spec §7.1.
#[derive(Debug, Subcommand)]
enum Command {
    /// Start the HTTP server and background jobs (FR-80, §7.6)
    Serve,
    /// Create the schema and run migrations only
    Migrate,
    /// Import the OFAC SDN list (§3.7.5)
    ListsUpdate,
    /// Block a wallet or supplier (stores only the hash)
    BlocklistAdd {
        /// Entry type
        #[arg(long = "type", value_enum)]
        kind: BlockKind,
        /// Raw value (wallet address or VAT ID); never stored or printed
        #[arg(long)]
        value: String,
        /// Reason code, ^[A-Z0-9_]{1,40}$
        #[arg(long)]
        reason: String,
    },
    /// Remove an internal block for a wallet or supplier
    BlocklistRemove {
        /// Entry type
        #[arg(long = "type", value_enum)]
        kind: BlockKind,
        /// Raw value (wallet address or VAT ID); never stored or printed
        #[arg(long)]
        value: String,
    },
    /// Delete all data for a subject hash (GDPR, §7.3)
    SubjectDelete {
        /// Subject hash, format hmac:…
        #[arg(long)]
        hash: String,
    },
    /// Load a seed file (§7.4, §7.5)
    DbSeed {
        /// Path to the seed JSON file
        #[arg(long)]
        file: PathBuf,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BlockKind {
    Wallet,
    Supplier,
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

fn not_implemented() -> ExitCode {
    eprintln!(r#"{{"ok":false,"error":"not_implemented"}}"#);
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    init_tracing();

    match cli.command {
        Command::Serve => not_implemented(),
        Command::Migrate => not_implemented(),
        Command::ListsUpdate => not_implemented(),
        Command::BlocklistAdd { .. } => not_implemented(),
        Command::BlocklistRemove { .. } => not_implemented(),
        Command::SubjectDelete { .. } => not_implemented(),
        Command::DbSeed { .. } => not_implemented(),
    }
}
