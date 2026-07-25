/// BitTorrent peer wire protocol — TCP handshake + message framing.
///
/// BEP-3: https://www.bittorrent.org/beps/bep_0003.html
/// BEP-10: Extension protocol (for ut_metadata)

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tracing::debug;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const MSG_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL_STR: &[u8] = b"BitTorrent protocol";

/// Extension bit position for BEP-10 (extension protocol).
const EXT_BIT_POSITION: usize = 20; // bit 20 from right = byte 5, bit 4

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MessageId {
    Choke = 0,
    Unchoke = 1,
    Interested = 2,
    NotInterested = 3,
    Have = 4,
    Bitfield = 5,
    Request = 6,
    Piece = 7,
    Cancel = 8,
    Extended = 20, // BEP-10
}

impl MessageId {
    fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Choke),
            1 => Some(Self::Unchoke),
            2 => Some(Self::Interested),
            3 => Some(Self::NotInterested),
            4 => Some(Self::Have),
            5 => Some(Self::Bitfield),
            6 => Some(Self::Request),
            7 => Some(Self::Piece),
            8 => Some(Self::Cancel),
            20 => Some(Self::Extended),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum PeerMessage {
    KeepAlive,
    Choke,
    Unchoke,
    Interested,
    NotInterested,
    Have(u32),
    Bitfield(Vec<u8>),
    Request { index: u32, begin: u32, length: u32 },
    Piece { index: u32, begin: u32, data: Bytes },
    Cancel { index: u32, begin: u32, length: u32 },
    Extended { ext_id: u8, payload: Bytes },
}

pub struct PeerConnection {
    stream: TcpStream,
    pub extensions: [u8; 8],   // peer's extension bits from handshake
    pub info_hash: [u8; 20],
    pub peer_id: [u8; 20],
    pub remote_peer_id: [u8; 20],
}

impl PeerConnection {
    /// Connect to a peer, perform handshake, return a connected PeerConnection.
    pub async fn connect(
        addr: SocketAddr,
        info_hash: &[u8; 20],
        peer_id: &[u8; 20],
        want_extensions: bool,
    ) -> Result<Self> {
        let stream = timeout(HANDSHAKE_TIMEOUT, TcpStream::connect(addr))
            .await
            .context("TCP connect timeout")?
            .context("TCP connect")?;

        stream.set_nodelay(true)?;

        let mut conn = Self {
            stream,
            extensions: [0u8; 8],
            info_hash: *info_hash,
            peer_id: *peer_id,
            remote_peer_id: [0u8; 20],
        };

        conn.do_handshake(want_extensions).await?;
        Ok(conn)
    }

    async fn do_handshake(&mut self, want_extensions: bool) -> Result<()> {
        // Build our handshake
        let mut hs = Vec::with_capacity(68);
        hs.push(PROTOCOL_STR.len() as u8);
        hs.extend_from_slice(PROTOCOL_STR);

        // Extension bits — set BEP-10 extension bit if requested
        let mut ext_bits = [0u8; 8];
        if want_extensions {
            ext_bits[5] |= 0x10; // bit 20
        }
        hs.extend_from_slice(&ext_bits);
        hs.extend_from_slice(&self.info_hash);
        hs.extend_from_slice(&self.peer_id);

        timeout(HANDSHAKE_TIMEOUT, self.stream.write_all(&hs))
            .await
            .context("handshake send timeout")?
            .context("handshake send")?;

        // Read peer's handshake
        let mut resp = [0u8; 68];
        timeout(HANDSHAKE_TIMEOUT, self.stream.read_exact(&mut resp))
            .await
            .context("handshake recv timeout")?
            .context("handshake recv")?;

        let pstrlen = resp[0] as usize;
        if pstrlen != PROTOCOL_STR.len() {
            bail!("Unexpected pstrlen: {pstrlen}");
        }
        if &resp[1..1 + pstrlen] != PROTOCOL_STR {
            bail!("Protocol mismatch in handshake");
        }

        self.extensions.copy_from_slice(&resp[1 + pstrlen..9 + pstrlen]);
        // Verify info hash
        if &resp[9 + pstrlen..29 + pstrlen] != &self.info_hash {
            bail!("Info hash mismatch in handshake");
        }
        self.remote_peer_id
            .copy_from_slice(&resp[29 + pstrlen..49 + pstrlen]);

        debug!("Handshake OK with peer {:?}", self.remote_peer_id);
        Ok(())
    }

    /// Returns true if the peer supports the BEP-10 extension protocol.
    pub fn supports_extensions(&self) -> bool {
        self.extensions[5] & 0x10 != 0
    }

    /// Send a message to the peer.
    pub async fn send(&mut self, msg: &PeerMessage) -> Result<()> {
        let bytes = encode_message(msg);
        self.stream
            .write_all(&bytes)
            .await
            .context("peer send")?;
        Ok(())
    }

    /// Read the next message from the peer.
    pub async fn recv(&mut self) -> Result<PeerMessage> {
        // Read 4-byte length prefix
        let mut len_buf = [0u8; 4];
        timeout(MSG_TIMEOUT, self.stream.read_exact(&mut len_buf))
            .await
            .context("msg recv timeout")?
            .context("msg recv length")?;

        let length = u32::from_be_bytes(len_buf) as usize;

        if length == 0 {
            return Ok(PeerMessage::KeepAlive);
        }

        // Sanity check
        if length > 262144 {
            tracing::warn!("Message too large: {} bytes (len_buf={:?})", length, len_buf);
            bail!("Message too large: {} bytes (likely corrupt stream)", length);
        }

        let mut payload = vec![0u8; length];
        timeout(MSG_TIMEOUT, self.stream.read_exact(&mut payload))
            .await
            .context("msg recv payload timeout")?
            .context("msg recv payload")?;

        decode_message(payload)
    }

    /// Send an Extended handshake (BEP-10 message id 0).
    /// `extensions_dict` is a bencoded dict describing supported extensions.
    pub async fn send_extended_handshake(&mut self, ut_metadata_id: u8) -> Result<()> {
        // Build a more complete extended handshake that peers expect:
        // - m: supported extension messages
        // - metadata_size: 0 (we don't have metadata yet, we're requesting it)
        // - reqq: request queue depth (250 is standard)
        // - v: client name
        let payload = format!(
            "d1:md11:ut_metadatai{}ee13:metadata_sizei0e4:reqqi250e1:v17:StreamLift/0.1.0e",
            ut_metadata_id
        );
        self.send(&PeerMessage::Extended {
            ext_id: 0,
            payload: Bytes::from(payload.into_bytes()),
        })
        .await
    }
}

// ── Message encoding / decoding ───────────────────────────────────────────────

fn encode_message(msg: &PeerMessage) -> Vec<u8> {
    let mut buf = Vec::new();
    match msg {
        PeerMessage::KeepAlive => {
            buf.extend_from_slice(&0u32.to_be_bytes());
        }
        PeerMessage::Interested => {
            buf.extend_from_slice(&1u32.to_be_bytes());
            buf.push(MessageId::Interested as u8);
        }
        PeerMessage::NotInterested => {
            buf.extend_from_slice(&1u32.to_be_bytes());
            buf.push(MessageId::NotInterested as u8);
        }
        PeerMessage::Request { index, begin, length } => {
            buf.extend_from_slice(&13u32.to_be_bytes());
            buf.push(MessageId::Request as u8);
            buf.extend_from_slice(&index.to_be_bytes());
            buf.extend_from_slice(&begin.to_be_bytes());
            buf.extend_from_slice(&length.to_be_bytes());
        }
        PeerMessage::Extended { ext_id, payload } => {
            let len = 2 + payload.len();
            buf.extend_from_slice(&(len as u32).to_be_bytes());
            buf.push(MessageId::Extended as u8);
            buf.push(*ext_id);
            buf.extend_from_slice(payload);
        }
        PeerMessage::Cancel { index, begin, length } => {
            buf.extend_from_slice(&13u32.to_be_bytes());
            buf.push(MessageId::Cancel as u8);
            buf.extend_from_slice(&index.to_be_bytes());
            buf.extend_from_slice(&begin.to_be_bytes());
            buf.extend_from_slice(&length.to_be_bytes());
        }
        _ => {} // other messages not needed for our use case
    }
    buf
}

fn decode_message(payload: Vec<u8>) -> Result<PeerMessage> {
    if payload.is_empty() {
        bail!("Empty message payload");
    }

    let id = MessageId::from_u8(payload[0]);
    let body = &payload[1..];

    match id {
        Some(MessageId::Choke) => Ok(PeerMessage::Choke),
        Some(MessageId::Unchoke) => Ok(PeerMessage::Unchoke),
        Some(MessageId::Interested) => Ok(PeerMessage::Interested),
        Some(MessageId::NotInterested) => Ok(PeerMessage::NotInterested),
        Some(MessageId::Have) => {
            if body.len() < 4 {
                bail!("Have message too short");
            }
            Ok(PeerMessage::Have(u32::from_be_bytes(body[..4].try_into().unwrap())))
        }
        Some(MessageId::Bitfield) => Ok(PeerMessage::Bitfield(body.to_vec())),
        Some(MessageId::Piece) => {
            if body.len() < 8 {
                bail!("Piece message too short");
            }
            let index = u32::from_be_bytes(body[..4].try_into().unwrap());
            let begin = u32::from_be_bytes(body[4..8].try_into().unwrap());
            let data = Bytes::copy_from_slice(&body[8..]);
            Ok(PeerMessage::Piece { index, begin, data })
        }
        Some(MessageId::Extended) => {
            if body.is_empty() {
                bail!("Extended message has no ext_id");
            }
            let ext_id = body[0];
            let payload = Bytes::copy_from_slice(&body[1..]);
            Ok(PeerMessage::Extended { ext_id, payload })
        }
        _ => bail!("Unknown message id: {}", payload[0]),
    }
}
