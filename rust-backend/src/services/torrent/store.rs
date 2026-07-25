#![allow(dead_code, unused_imports, unused_variables)]
///
/// Pieces are stored in a HashMap and evicted once they've been
/// consumed by the upload pipeline (with a configurable buffer window).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub struct PieceStore {
    inner: Arc<Mutex<StoreInner>>,
}

#[derive(Debug)]
struct StoreInner {
    pieces: HashMap<u32, Vec<u8>>,
    piece_length: u32,
    total_pieces: u32,
}

impl PieceStore {
    pub fn new(piece_length: u32, total_pieces: u32) -> Self {
        Self {
            inner: Arc::new(Mutex::new(StoreInner {
                pieces: HashMap::new(),
                piece_length,
                total_pieces,
            })),
        }
    }

    /// Store a piece.
    pub fn put(&self, index: u32, data: Vec<u8>) {
        let mut inner = self.inner.lock().unwrap();
        inner.pieces.insert(index, data);
    }

    /// Retrieve a piece (does not remove it).
    pub fn get(&self, index: u32) -> Option<Vec<u8>> {
        let inner = self.inner.lock().unwrap();
        inner.pieces.get(&index).cloned()
    }

    /// Evict a piece (free memory). Mirrors FreeTierChunkStore.evict().
    pub fn evict(&self, index: u32) {
        let mut inner = self.inner.lock().unwrap();
        inner.pieces.remove(&index);
    }

    /// Evict all pieces before `before_index` (keeping a buffer of `buffer_size` ahead).
    pub fn evict_before(&self, consumed_index: u32, buffer_size: u32) {
        if consumed_index < buffer_size {
            return;
        }
        let evict_up_to = consumed_index - buffer_size;
        let mut inner = self.inner.lock().unwrap();
        inner.pieces.retain(|&idx, _| idx >= evict_up_to);
    }

    pub fn piece_length(&self) -> u32 {
        self.inner.lock().unwrap().piece_length
    }

    pub fn total_pieces(&self) -> u32 {
        self.inner.lock().unwrap().total_pieces
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().pieces.len()
    }

    /// Current memory usage estimate in bytes.
    pub fn memory_usage(&self) -> usize {
        let inner = self.inner.lock().unwrap();
        inner
            .pieces
            .values()
            .map(|v| v.len())
            .sum()
    }
}

impl Clone for PieceStore {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}
