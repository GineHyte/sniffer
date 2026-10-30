//! Redis keys with the sniffer: prefix (spec 3.9).
//!
//! Every key carries the `sniffer:` prefix because the agents share the instance.
//! Functions are generic over [`redis::aio::ConnectionLike`], so they accept a
//! `MultiplexedConnection` (what [`connect`] returns) or, once the crate enables the
//! redis `connection-manager` feature, a `ConnectionManager`.

use redis::aio::{ConnectionLike, MultiplexedConnection};
use redis::RedisResult;
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Prefix of every key this service writes.
pub const KEY_PREFIX: &str = "sniffer:";

/// Invoice lock TTL: 120 s, set with `PX` (spec 3.9, step 12).
pub const LOCK_TTL_MS: u64 = 120_000;
/// Blockfrost cache TTL in seconds.
pub const BF_CACHE_TTL_SECS: u64 = 600;
/// VIES cache TTL in seconds.
pub const VIES_CACHE_TTL_SECS: u64 = 86_400;
/// Chainabuse cache TTL in seconds.
pub const CA_CACHE_TTL_SECS: u64 = 3_600;

/// `sniffer:xml:<check_id>`
pub fn xml_key(check_id: &str) -> String {
    format!("sniffer:xml:{check_id}")
}

/// `sniffer:lock:invoice:<invoice_hash>`
pub fn invoice_lock_key(invoice_hash: &str) -> String {
    format!("sniffer:lock:invoice:{invoice_hash}")
}

/// `sniffer:cache:bf:<address_hash>`
pub fn bf_cache_key(address_hash: &str) -> String {
    format!("sniffer:cache:bf:{address_hash}")
}

/// `sniffer:cache:vies:<supplier_hash>`
pub fn vies_cache_key(supplier_hash: &str) -> String {
    format!("sniffer:cache:vies:{supplier_hash}")
}

/// `sniffer:cache:ca:<address_hash>`
pub fn ca_cache_key(address_hash: &str) -> String {
    format!("sniffer:cache:ca:{address_hash}")
}

/// Opens a multiplexed connection (cheap to clone, shareable across tasks).
pub async fn connect(redis_url: &str) -> RedisResult<MultiplexedConnection> {
    redis::Client::open(redis_url)?
        .get_multiplexed_async_connection()
        .await
}

/// `PING`; for the start check (FR-80) and `/health`.
pub async fn ping<C: ConnectionLike + Send>(conn: &mut C) -> RedisResult<()> {
    let _: String = redis::cmd("PING").query_async(conn).await?;
    Ok(())
}

/// `SET sniffer:lock:invoice:<hash> 1 NX PX 120000`. Returns `true` if this call
/// acquired the lock, `false` if another check holds it.
pub async fn try_lock_invoice<C: ConnectionLike + Send>(
    conn: &mut C,
    invoice_hash: &str,
) -> RedisResult<bool> {
    let reply: Option<String> = redis::cmd("SET")
        .arg(invoice_lock_key(invoice_hash))
        .arg(1)
        .arg("NX")
        .arg("PX")
        .arg(LOCK_TTL_MS)
        .query_async(conn)
        .await?;
    Ok(reply.is_some())
}

/// Releases the invoice lock.
pub async fn unlock_invoice<C: ConnectionLike + Send>(
    conn: &mut C,
    invoice_hash: &str,
) -> RedisResult<()> {
    let _: i64 = redis::cmd("DEL")
        .arg(invoice_lock_key(invoice_hash))
        .query_async(conn)
        .await?;
    Ok(())
}

/// `SET sniffer:xml:<check_id> <xml> EX <ttl_secs>` (`XML_TTL_SECONDS`).
pub async fn put_xml<C: ConnectionLike + Send>(
    conn: &mut C,
    check_id: &str,
    xml: &str,
    ttl_secs: u64,
) -> RedisResult<()> {
    let _: String = redis::cmd("SET")
        .arg(xml_key(check_id))
        .arg(xml)
        .arg("EX")
        .arg(ttl_secs)
        .query_async(conn)
        .await?;
    Ok(())
}

/// Stored XML for a check, `None` if missing or expired.
pub async fn get_xml<C: ConnectionLike + Send>(
    conn: &mut C,
    check_id: &str,
) -> RedisResult<Option<String>> {
    redis::cmd("GET")
        .arg(xml_key(check_id))
        .query_async(conn)
        .await
}

/// Deletes the stored XML (FR-63 rollback, 7.3 subject-delete).
pub async fn del_xml<C: ConnectionLike + Send>(conn: &mut C, check_id: &str) -> RedisResult<()> {
    let _: i64 = redis::cmd("DEL")
        .arg(xml_key(check_id))
        .query_async(conn)
        .await?;
    Ok(())
}

/// Reads a JSON cache value. A value that no longer deserializes counts as a miss.
pub async fn cache_get_json<C: ConnectionLike + Send, T: DeserializeOwned>(
    conn: &mut C,
    key: &str,
) -> RedisResult<Option<T>> {
    let raw: Option<String> = redis::cmd("GET").arg(key).query_async(conn).await?;
    Ok(raw.and_then(|s| match serde_json::from_str(&s) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!(key, error = %e, "ignoring undecodable cache value");
            None
        }
    }))
}

/// Writes a JSON cache value with `EX ttl_secs`.
pub async fn cache_put_json<C: ConnectionLike + Send, T: Serialize + ?Sized>(
    conn: &mut C,
    key: &str,
    value: &T,
    ttl_secs: u64,
) -> RedisResult<()> {
    let json = serde_json::to_string(value).map_err(|e| {
        redis::RedisError::from((
            redis::ErrorKind::Client,
            "cache value serialization failed",
            e.to_string(),
        ))
    })?;
    let _: String = redis::cmd("SET")
        .arg(key)
        .arg(json)
        .arg("EX")
        .arg(ttl_secs)
        .query_async(conn)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_builders_match_spec() {
        assert_eq!(xml_key("chk_01ABC"), "sniffer:xml:chk_01ABC");
        assert_eq!(
            invoice_lock_key("hmac:abc"),
            "sniffer:lock:invoice:hmac:abc"
        );
        assert_eq!(bf_cache_key("hmac:a1"), "sniffer:cache:bf:hmac:a1");
        assert_eq!(vies_cache_key("hmac:s1"), "sniffer:cache:vies:hmac:s1");
        assert_eq!(ca_cache_key("hmac:a1"), "sniffer:cache:ca:hmac:a1");
    }

    #[test]
    fn all_keys_carry_prefix() {
        for key in [
            xml_key("x"),
            invoice_lock_key("x"),
            bf_cache_key("x"),
            vies_cache_key("x"),
            ca_cache_key("x"),
        ] {
            assert!(key.starts_with(KEY_PREFIX), "{key}");
        }
    }

    #[test]
    fn ttls_match_spec() {
        assert_eq!(LOCK_TTL_MS, 120 * 1000);
        assert_eq!(BF_CACHE_TTL_SECS, 600);
        assert_eq!(VIES_CACHE_TTL_SECS, 86_400);
        assert_eq!(CA_CACHE_TTL_SECS, 3_600);
    }
}
