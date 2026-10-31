//! `db-seed` (spec 7.4, 7.5). Owner: Task 18.

use sqlx::PgPool;

use crate::hashing::HmacKey;
use crate::normalize::LegalForms;

/// Loads a seed file. Repeatable: existing invoice hashes are skipped. Returns the number of inserted invoices.
pub async fn seed_file(
    pool: &PgPool,
    key: &HmacKey,
    legal_forms: &LegalForms,
    json: &str,
) -> anyhow::Result<usize> {
    let _ = (pool, key, legal_forms, json);
    anyhow::bail!("not implemented")
}
