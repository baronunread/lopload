//! Signature verification helpers.

use crate::Result;
use minisign_verify::{PublicKey, Signature};

/// Verifies a downloaded payload against a Minisign public key and detached signature.
///
/// This is the low-level verification primitive used by the updater before any
/// installer bytes are handed to the platform-specific install path.
pub fn verify_minisign(payload: &[u8], pubkey: &str, signature: &str) -> Result<()> {
    let public_key = PublicKey::decode(pubkey)?;
    let signature = Signature::decode(signature)?;
    public_key.verify(payload, &signature, true)?;
    Ok(())
}
