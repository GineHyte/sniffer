//! Invoice Scam Sniffer – Initial Check (spec v1.0, docs/initial-check-spec.md).
//! Module slots are declared here up front so parallel work never edits the same file.

pub mod address;
pub mod hashing;
pub mod normalize;
pub mod store;
pub mod config;
pub mod mustang;
pub mod parse;
pub mod sources;
