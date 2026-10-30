//! Invoice Scam Sniffer – Initial Check (spec v1.0, docs/initial-check-spec.md).
//! Module slots are declared here up front so parallel work never edits the same file.

pub mod address;
pub mod config;
pub mod criteria;
pub mod hashing;
pub mod model;
pub mod mustang;
pub mod normalize;
pub mod parse;
pub mod scoring;
pub mod sources;
pub mod store;
