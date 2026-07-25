/// BitTorrent wire protocol — robust message framing with buffered I/O.
///
/// Handles partial reads, connection resets, and protocol violations gracefully.
/// Uses a BufReader for efficient reading and a write buffer for batched sends.

use anyhow::{bail, Context, Result};
use bytes::{Bytes, BytesMut, Buf, BufMut};
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tracing::debug;

const PROTOCOL_STR: &[u8] = b"BitTorrent protocol";
const MAX_MESSAGE_SIZE: usize = 1 << 17; // 128KB — max piece block + overhead

/// A framed BitTorrent connection with buffered I/O.
pub struct WireConn {
    reader: BufReader<tokio::io::ReadHalf<TcpStream>>,
    writer: BufWriter<tokio::io::WriteHalf<TcpStream>>,
    pub addr: SocketAddr,
    pub extensions: [u8; 8],
    pub peer_id: [u8; 20],
    pub info_hash: [u8; 20],
    pub remote_peer_id: [u8; 20],
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MsgId {
    Choke = 0,
    Unchoke = 1,
    Interested = 2,
    NotInterested = 3,
    Have = 4,
    Bitfield = 5,
    Request = 6,
    Piece = 7,
    Cancel = 8,
    Extended = 20,
}

#[derive(Debug)]
pub enum Message {
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
    Extended { id: u8, payload: Bytes },
}

impl WireConn {
    /// Connect to a peer and perform the BitTorrent handshake.
    pub async fn connect(
        addr: SocketAddr,
        info_hash: &[u8; 20],
        our_peer_id: &[u8; 20],
        want_ext: bool,
        connect_timeout: Duration,
    ) -> Result<Self> {
        let stream = timeout(connect_timeout, TcpStream::connect(addr))
            .await
            .context("connect timeout")?
            .context("TCP connect")?;
        stream.set_nodelay(true)?;

        Self::from_stream(stream, addr, info_hash, our_peer_id, want_ext, true).await
    }

    /// Wrap an already-connected TcpStream (from the listener accepting a connection).
    pub async fn from_incoming(
        stream: TcpStream,
        addr: SocketAddr,
        info_hash: &[u8; 20],
        our_peer_id: &[u8; 20],
    ) -> Result<Self> {
        stream.set_nodelay(true)?;
        // For incoming connections, the peer sends handshake first — we read then respond
        Self::from_stream(stream, addr, info_hash, our_peer_id, true, false).await
    }

    async fn from_stream(
        stream: TcpStream,
        addr: SocketAddr,
        info_hash: &[u8; 20],
        our_peer_id: &[u8; 20],
        want_ext: bool,
        we_initiate: bool,
    ) -> Result<Self> {
        let (rh, wh) = tokio::io::split(stream);
        let mut reader = BufReader::new(rh);
        let mut writer = BufWriter::new(wh);

        let mut ext_bits = [0u8; 8];
        if want_ext {
            ext_bits[5] |= 0x10; // BEP-10
        }

        let mut remote_extensions = [0u8; 8];
        let mut remote_peer_id = [0u8; 20];

        if we_initiate {
            // We send first, then read
            send_handshake(&mut writer, info_hash, our_peer_id, &ext_bits).await?;
            let (re, rp, rh) = read_handshake(&mut reader, Some(info_hash)).await?;
            remote_extensions = re;
            remote_peer_id = rp;
        } else {
            // Incoming: read first, then send
            let (re, rp, received_hash) = read_handshake(&mut reader, None).await?;
            // Verify info hash matches what we expect
            if &received_hash != info_hash {
                bail!("Incoming peer has wrong info_hash");
            }
            remote_extensions = re;
            remote_peer_id = rp;
            send_handshake(&mut writer, info_hash, our_peer_id, &ext_bits).await?;
        }

        Ok(Self {
            reader,
            writer,
            addr,
            extensions: remote_extensions,
            peer_id: *our_peer_id,
            info_hash: *info_hash,
            remote_peer_id,
        })
    }

    pub fn supports_extensions(&self) -> bool {
        self.extensions[5] & 0x10 != 0
    }

    /// Read the next message. Returns None on clean disconnect.
    pub async fn read_message(&mut self, read_timeout: Duration) -> Result<Option<Message>> {
        let mut len_buf = [0u8; 4];
        match timeout(read_timeout, self.reader.read_exact(&mut len_buf)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Ok(Err(e)) => return Err(e.into()),
            Err(_) => return Ok(Some(Message::KeepAlive)), // timeout = treat as keepalive
        }

        let length = u32::from_be_bytes(len_buf) as usize;
        if length == 0 {
            return Ok(Some(Message::KeepAlive));
        }
        if length > MAX_MESSAGE_SIZE {
            bail!("Message too large: {length} bytes");
        }

        let mut payload = vec![0u8; length];
        timeout(Duration::from_secs(30), self.reader.read_exact(&mut payload))
            .await
            .context("payload read timeout")?
            .context("read payload")?;

        Ok(Some(decode_msg(&payload)?))
    }

    /// Send a message.
    pub async fn send_message(&mut self, msg: &Message) -> Result<()> {
        let data = encode_msg(msg);
        self.writer.write_all(&data).await.context("write message")?;
        self.writer.flush().await.context("flush")?;
        Ok(())
    }

    /// Send our BEP-10 extended handshake.
    pub async fn send_ext_handshake(&mut self, ut_metadata_id: u8) -> Result<()> {
        let payload = format!(
            "d1:md11:ut_metadatai{}ee13:metadata_sizei0e4:reqqi250e1:v17:StreamLift/0.1.0e",
            ut_metadata_id
        );
        self.send_message(&Message::Extended {
            id: 0,
            payload: Bytes::from(payload.into_bytes()),
        }).await
    }
}

// ── Handshake helpers ─────────────────────────────────────────────────────────

async fn send_handshake(
    writer: &mut BufWriter<tokio::io::WriteHalf<TcpStream>>,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
    ext_bits: &[u8; 8],
) -> Result<()> {
    let mut hs = Vec::with_capacity(68);
    hs.push(PROTOCOL_STR.len() as u8);
    hs.extend_from_slice(PROTOCOL_STR);
    hs.extend_from_slice(ext_bits);
    hs.extend_from_slice(info_hash);
    hs.extend_from_slice(peer_id);
    writer.write_all(&hs).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_handshake(
    reader: &mut BufReader<tokio::io::ReadHalf<TcpStream>>,
    expected_hash: Option<&[u8; 20]>,
) -> Result<([u8; 8], [u8; 20], [u8; 20])> {
    let mut resp = [0u8; 68];
    timeout(Duration::from_secs(8), reader.read_exact(&mut resp))
        .await
        .context("handshake read timeout")?
        .context("handshake read")?;

    let pstrlen = resp[0] as usize;
    if pstrlen != PROTOCOL_STR.len() || &resp[1..1 + pstrlen] != PROTOCOL_STR {
        bail!("Protocol mismatch");
    }

    let mut extensions = [0u8; 8];
    extensions.copy_from_slice(&resp[1 + pstrlen..9 + pstrlen]);

    let mut info_hash = [0u8; 20];
    info_hash.copy_from_slice(&resp[9 + pstrlen..29 + pstrlen]);

    if let Some(expected) = expected_hash {
        if &info_hash != expected {
            bail!("Info hash mismatch");
        }
    }

    let mut peer_id = [0u8; 20];
    peer_id.copy_from_slice(&resp[29 + pstrlen..49 + pstrlen]);

    Ok((extensions, peer_id, info_hash))
}

// ── Message encode/decode ─────────────────────────────────────────────────────

fn decode_msg(payload: &[u8]) -> Result<Message> {
    if payload.is_empty() { bail!("Empty payload"); }
    match payload[0] {
        0 => Ok(Message::Choke),
        1 => Ok(Message::Unchoke),
        2 => Ok(Message::Interested),
        3 => Ok(Message::NotInterested),
        4 if payload.len() >= 5 => Ok(Message::Have(u32::from_be_bytes(payload[1..5].try_into().unwrap()))),
        5 => Ok(Message::Bitfield(payload[1..].to_vec())),
        6 if payload.len() >= 13 => Ok(Message::Request {
            index: u32::from_be_bytes(payload[1..5].try_into().unwrap()),
            begin: u32::from_be_bytes(payload[5..9].try_into().unwrap()),
            length: u32::from_be_bytes(payload[9..13].try_into().unwrap()),
        }),
        7 if payload.len() >= 9 => Ok(Message::Piece {
            index: u32::from_be_bytes(payload[1..5].try_into().unwrap()),
            begin: u32::from_be_bytes(payload[5..9].try_into().unwrap()),
            data: Bytes::copy_from_slice(&payload[9..]),
        }),
        8 if payload.len() >= 13 => Ok(Message::Cancel {
            index: u32::from_be_bytes(payload[1..5].try_into().unwrap()),
            begin: u32::from_be_bytes(payload[5..9].try_into().unwrap()),
            length: u32::from_be_bytes(payload[9..13].try_into().unwrap()),
        }),
        20 if payload.len() >= 2 => Ok(Message::Extended {
            id: payload[1],
            payload: Bytes::copy_from_slice(&payload[2..]),
        }),
        id => bail!("Unknown message id: {id}"),
    }
}

fn encode_msg(msg: &Message) -> Vec<u8> {
    let mut buf = Vec::new();
    match msg {
        Message::KeepAlive => buf.extend_from_slice(&0u32.to_be_bytes()),
        Message::Choke => { buf.extend_from_slice(&1u32.to_be_bytes()); buf.push(0); }
        Message::Unchoke => { buf.extend_from_slice(&1u32.to_be_bytes()); buf.push(1); }
        Message::Interested => { buf.extend_from_slice(&1u32.to_be_bytes()); buf.push(2); }
        Message::NotInterested => { buf.extend_from_slice(&1u32.to_be_bytes()); buf.push(3); }
        Message::Have(idx) => {
            buf.extend_from_slice(&5u32.to_be_bytes());
            buf.push(4);
            buf.extend_from_slice(&idx.to_be_bytes());
        }
        Message::Request { index, begin, length } => {
            buf.extend_from_slice(&13u32.to_be_bytes());
            buf.push(6);
            buf.extend_from_slice(&index.to_be_bytes());
            buf.extend_from_slice(&begin.to_be_bytes());
            buf.extend_from_slice(&length.to_be_bytes());
        }
        Message::Piece { index, begin, data } => {
            let len = 9 + data.len();
            buf.extend_from_slice(&(len as u32).to_be_bytes());
            buf.push(7);
            buf.extend_from_slice(&index.to_be_bytes());
            buf.extend_from_slice(&begin.to_be_bytes());
            buf.extend_from_slice(data);
        }
        Message::Cancel { index, begin, length } => {
            buf.extend_from_slice(&13u32.to_be_bytes());
            buf.push(8);
            buf.extend_from_slice(&index.to_be_bytes());
            buf.extend_from_slice(&begin.to_be_bytes());
            buf.extend_from_slice(&length.to_be_bytes());
        }
        Message::Extended { id, payload } => {
            let len = 2 + payload.len();
            buf.extend_from_slice(&(len as u32).to_be_bytes());
            buf.push(20);
            buf.push(*id);
            buf.extend_from_slice(payload);
        }
        _ => buf.extend_from_slice(&0u32.to_be_bytes()),
    }
    buf
}
