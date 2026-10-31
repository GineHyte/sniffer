# Sniffer backend image (docs/initial-check-spec.md §2). Needs BuildKit (default since
# Docker 23) for the cache mounts.
#
# Image tags are pinned exactly; the build stage uses the same Rust version as
# rust-toolchain.toml (1.99.1). Bookworm (glibc 2.36) builds a binary that runs on the
# Ubuntu 24.04 (glibc 2.39) runtime.

FROM rust:1.99.1-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked --bin sniffer \
 && cp target/release/sniffer /usr/local/bin/sniffer

# Compile MustangDaemon.java against the Mustang jar using the JDK image.
# The runtime image uses JRE-only, so compilation must happen here.
FROM eclipse-temurin:21.0.13_9-jdk-noble AS java-build
ARG MUSTANG_URL=https://github.com/ZUGFeRD/mustangproject/releases/download/core-2.26.0/Mustang-CLI-2.26.0.jar
ARG MUSTANG_SHA256=42d7868cb68264874a7b8cab4c3587b03b23ccc7cd72373da917f66758bb9736
RUN curl -fsSL --retry 3 -o /tmp/Mustang-CLI-2.26.0.jar "$MUSTANG_URL" \
 && echo "$MUSTANG_SHA256  /tmp/Mustang-CLI-2.26.0.jar" | sha256sum -c -
COPY mustang-daemon/MustangDaemon.java /tmp/
RUN javac -cp /tmp/Mustang-CLI-2.26.0.jar /tmp/MustangDaemon.java

FROM eclipse-temurin:21.0.13_9-jre-noble

# Mustang-CLI 2.26.0 (release core-2.26.0); the build fails on a SHA-256 mismatch.
ARG MUSTANG_URL=https://github.com/ZUGFeRD/mustangproject/releases/download/core-2.26.0/Mustang-CLI-2.26.0.jar
ARG MUSTANG_SHA256=42d7868cb68264874a7b8cab4c3587b03b23ccc7cd72373da917f66758bb9736
RUN mkdir -p /opt/mustang \
 && curl -fsSL --retry 3 -o /opt/mustang/Mustang-CLI-2.26.0.jar "$MUSTANG_URL" \
 && echo "$MUSTANG_SHA256  /opt/mustang/Mustang-CLI-2.26.0.jar" | sha256sum -c - \
 && chmod 0444 /opt/mustang/Mustang-CLI-2.26.0.jar
COPY --from=java-build /tmp/MustangDaemon.class /opt/mustang/

RUN groupadd --system --gid 10001 sniffer \
 && useradd --system --uid 10001 --gid sniffer --home-dir /app --shell /usr/sbin/nologin sniffer

WORKDIR /app
COPY --from=build /usr/local/bin/sniffer /usr/local/bin/sniffer
# Migrations are embedded in the binary; the copy documents the schema in the image.
COPY migrations ./migrations
COPY config ./config
COPY data ./data
COPY seed ./seed

ENV SNIFFER_BIND_ADDR=0.0.0.0:8080 \
    CONFIG_DIR=/app/config \
    DATA_DIR=/app/data \
    MUSTANG_JAR=/opt/mustang/Mustang-CLI-2.26.0.jar \
    MUSTANG_MODE=daemon \
    JAVA_BIN=java

USER sniffer
EXPOSE 8080
CMD ["sniffer", "serve"]
