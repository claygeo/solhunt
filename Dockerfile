FROM ghcr.io/foundry-rs/foundry:latest

# Create workspace directory
RUN mkdir -p /workspace
WORKDIR /workspace

# Pre-initialize a forge project so dependencies are cached
RUN forge init --no-git /workspace/template && \
    cd /workspace/template && \
    forge install foundry-rs/forge-std --no-git && \
    forge build

# Keep the template for fast project scaffolding
# Each scan copies from /workspace/template to /workspace/scan

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["sleep infinity"]
