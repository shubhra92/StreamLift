/// StreamLift Torrent Engine — production-grade BitTorrent client.
///
/// Architecture:
///   - Listener: accepts incoming peer connections (critical for NAT traversal)
///   - PeerManager: manages a pool of active peer connections
///   - PieceManager: coordinates which pieces to request from which peers
///   - Session: ties everything together for one torrent download
///
/// This is designed to be as reliable as (or better than) WebTorrent.

pub mod listener;
pub mod peer_pool;
pub mod session;
pub mod wire;
