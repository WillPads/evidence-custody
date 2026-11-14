//! SHA-256 helpers.
//!
//! A hash is a fixed-length "fingerprint" of some data. Change even one byte
//! of the input and the fingerprint changes completely, which is what makes
//! tampering detectable.

use sha2::{Digest, Sha256};
use std::io::Read;

/// The "previous hash" of the very first record (there is nothing before it).
pub const GENESIS_PREV_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// Turns raw hash bytes into the usual 64-character lowercase hex string.
/// (sha2 0.11 no longer supports printing with `{:x}`, so we do it ourselves.)
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Hashes data that is already in memory (used by the web app and by records).
pub fn hash_bytes(data: &[u8]) -> String {
    to_hex(&Sha256::digest(data))
}

/// Hashes anything readable (e.g. a file) in 64 KB chunks, so even a 10 GB
/// disk image never has to fit in memory. Returns (hash, size in bytes).
pub fn hash_reader<R: Read>(mut reader: R) -> std::io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((to_hex(&hasher.finalize()), total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_sha256_value() {
        // Official test vector: SHA-256("abc")
        assert_eq!(
            hash_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn reader_matches_bytes() {
        let data = vec![7u8; 200_000]; // bigger than one 64 KB chunk
        let (h, size) = hash_reader(&data[..]).unwrap();
        assert_eq!(h, hash_bytes(&data));
        assert_eq!(size, 200_000);
    }
}
