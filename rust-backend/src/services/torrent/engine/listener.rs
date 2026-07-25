#![allow(dead_code, unused_imports, unused_variables, unused_mut)]
/// TCP Listener for incoming peer connections.

use anyhow::{Context, Result};
use std::net::SocketAddr;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};
use tracing::{debug, info, warn};

/// An incoming connection ready to be associated with a torrent session.
pub struct IncomingPeer {
    pub stream: TcpStream,
    pub addr: SocketAddr,
    pub info_hash: [u8; 20],
}

pub struct PeerListener {
    port: u16,
    incoming_tx: mpsc::Sender<IncomingPeer>,
}

impl PeerListener {
    pub async fn start(incoming_tx: mpsc::Sender<IncomingPeer>) -> Result<(Self, u16)> {
        let listener = TcpListener::bind("0.0.0.0:0").await.context("bind listener")?;
        let port = listener.local_addr()?.port();
        info!("Torrent peer listener on port {port}");

        let tx = incoming_tx.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        debug!("Incoming peer from {addr}");
                        let tx = tx.clone();
                        tokio::spawn(async move {
                            match handle_incoming(stream, addr).await {
                                Ok(peer) => { let _ = tx.send(peer).await; }
                                Err(e) => debug!("Incoming {addr} failed: {e}"),
                            }
                        });
                    }
                    Err(e) => {
                        warn!("Accept error: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        });

        Ok((Self { port, incoming_tx }, port))
    }

    pub fn port(&self) -> u16 { self.port }
}

async fn handle_incoming(mut stream: TcpStream, addr: SocketAddr) -> Result<IncomingPeer> {
    stream.set_nodelay(true)?;

    let mut buf = [0u8; 68];
    timeout(Duration::from_secs(5), stream.read_exact(&mut buf))
        .await
        .context("handshake timeout")?
        .context("read handshake")?;

    let pstrlen = buf[0] as usize;
    if pstrlen != 19 || &buf[1..20] != b"BitTorrent protocol" {
        anyhow::bail!("Not BitTorrent");
    }

    let mut info_hash = [0u8; 20];
    info_hash.copy_from_slice(&buf[28..48]);

    Ok(IncomingPeer { stream, addr, info_hash })
}
