//! Invoice Scam Sniffer – Initial Check (spec v1.0, docs/initial-check-spec.md).
//! Module slots are declared here up front so parallel work never edits the same file.

pub mod address;
pub mod api;
pub mod app;
pub mod check;
pub mod config;
pub mod criteria;
pub mod decisions;
pub mod hashing;
pub mod jobs;
pub mod model;
pub mod mustang;
pub mod normalize;
pub mod parse;
pub mod sanctions;
pub mod scoring;
pub mod seed;
pub mod sources;
pub mod store;
