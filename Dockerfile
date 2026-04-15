FROM ghcr.io/foundry-rs/foundry:latest

USER root
ENV FOUNDRY_DISABLE_NIGHTLY_WARNING=1

# Create workspace directory
RUN mkdir -p /workspace && chmod 777 /workspace
WORKDIR /workspace

# Pre-initialize a forge project with common DeFi dependencies
RUN forge init --no-git /workspace/template && \
    cd /workspace/template && \
    forge install OpenZeppelin/openzeppelin-contracts --no-git && \
    forge install Uniswap/v2-core --no-git && \
    forge install Uniswap/v3-core --no-git && \
    forge install smartcontractkit/chainlink --no-git && \
    forge build

# Keep the template for fast project scaffolding
# Each scan copies from /workspace/template to /workspace/scan

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["sleep infinity"]
