# ── Stage 1: Build ─────────────────────────────────────────────────────────────
FROM rust:1.97 AS builder

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src/ src/

# Build release binary
RUN cargo build --release --bin server

# ── Stage 2: Runtime ───────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# Install runtime dependencies (TLS, DNS)
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary from builder
COPY --from=builder /app/target/release/server /app/server

# Create downloads directory
RUN mkdir -p /app/downloads

EXPOSE 4001

CMD ["./server"]
