# syntax=docker/dockerfile:1.7

# Harbor task image for the Similarity Obsidian plugin.
#
# The final stage follows the Harbor template as written (ubuntu:24.04 pinned by digest,
# the standard support tools, WORKDIR /app, the v0.1.0-init checkpoint, CMD bash). The
# stages above it only exist to pick where the codebase comes from, since a COPY cannot
# be made conditional:
#
#   SOURCE=local   (default)  Shallow-clone the repository from the build context's own
#                             .git. Committed state only -- the working tree is never
#                             copied in, so commit or stash first. GIT_REF takes any
#                             commit, branch or tag present locally (short SHAs are fine).
#   SOURCE=commit             Shallow-fetch a single commit from REPO_URL, the way the
#                             template's "by exact commit SHA" line does. COMMIT must be a
#                             full 40-character SHA, or a branch/tag name: a remote cannot
#                             serve a shallow fetch of an abbreviated SHA. Use this for a
#                             real task -- it pins a public commit with no local state.
#   SOURCE=codebase           The template's default: COPY codebase/ . -- for when this
#                             Dockerfile sits in a Harbor task directory next to a
#                             codebase/ copy of the repo instead of inside the repo.
#
# Harbor runs amd64, so build it that way even on Apple Silicon:
#   docker build --platform linux/amd64 -t similarity-task .
#   docker build --platform linux/amd64 -t similarity-task --build-arg GIT_REF=5daa245 .
#   docker build --platform linux/amd64 -t similarity-task \
#     --build-arg SOURCE=commit \
#     --build-arg COMMIT=62240ffcd491432280f5c24aef60ddcfbcd75e47 .
#
#   docker run --rm -it --platform linux/amd64 similarity-task      # bash in /app
#
# In the container: `npm test` runs the suite (pretest compiles src/ to dist/) and
# `npm run build` bundles main.js. Dependencies are already installed, so neither needs
# network access, and both leave the working tree clean -- dist/ and main.js are ignored.

# The base image is pinned once here and used by every stage.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:c35e29c9450151419d9448b0fd75374fec4fff364a27f176fb458d472dfc9e54
ARG SOURCE=local

# --------------------------------------------------------------------------------------
# Source selection (built before the task image; only the selected stage runs).
# --------------------------------------------------------------------------------------
FROM ${UBUNTU_IMAGE} AS source-base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y git ca-certificates && rm -rf /var/lib/apt/lists/*

# SOURCE=local: shallow-clone out of the build context's own .git. .dockerignore narrows
# the context to .git and gitignore, so nothing from a dirty working tree can leak in.
# A shallow fetch can only ask for a full object id, so GIT_REF is resolved against the
# context repo first and that exact commit is then served over file://
# (uploadpack.allowAnySHA1InWant lets it hand out a commit that is not a branch tip).
FROM source-base AS source-local
ARG GIT_REF=HEAD
COPY .git /context/.git
RUN set -eux; \
    git config --global --add safe.directory /context; \
    git -C /context config --bool core.bare true; \
    git -C /context config --bool uploadpack.allowAnySHA1InWant true; \
    commit="$(git -C /context rev-parse --verify "${GIT_REF}^{commit}")"; \
    mkdir -p /src; \
    git -C /src init -q; \
    git -C /src remote add origin file:///context; \
    git -C /src fetch -q --depth 1 origin "$commit"; \
    git -C /src checkout -q --detach FETCH_HEAD; \
    printf 'local .git @ %s\n' "$commit" > /build-commit; \
    rm -rf /src/.git; \
    cat /build-commit

# SOURCE=commit: shallow-fetch one commit from the remote. `rm -rf /src/.git` drops the
# upstream history so the checkpoint below re-inits from a clean baseline.
FROM source-base AS source-commit
ARG REPO_URL=https://github.com/JoramMillenaar/obsidian-related-notes.git
ARG COMMIT
RUN set -eux; \
    if [ -z "${COMMIT:-}" ]; then \
      echo "SOURCE=commit requires --build-arg COMMIT=<full-sha|branch|tag>" >&2; \
      exit 1; \
    fi; \
    mkdir -p /src; \
    git -C /src init -q; \
    git -C /src remote add origin "${REPO_URL}"; \
    git -C /src fetch -q --depth 1 origin "${COMMIT}"; \
    git -C /src checkout -q --detach FETCH_HEAD; \
    printf '%s @ %s\n' "${REPO_URL}" "$(git -C /src rev-parse HEAD)" > /build-commit; \
    rm -rf /src/.git; \
    cat /build-commit

# SOURCE=codebase: the template's own path, for a task directory holding codebase/.
FROM source-base AS source-codebase
COPY codebase/ /src/
RUN set -eux; \
    printf 'codebase/ directory (no git metadata)\n' > /build-commit; \
    rm -rf /src/.git

# Resolves to source-local, source-commit or source-codebase, per the SOURCE build arg.
FROM source-${SOURCE} AS source

# --------------------------------------------------------------------------------------
# The task image.
# --------------------------------------------------------------------------------------
# If you need to use a different base image, please choose the linux/amd64 platform variant and include the fingerprint so that we pin the exact image.
FROM ${UBUNTU_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive

# These are support tools that should go into all tasks. Don't alter these unless you need to adjust for a different base image.
RUN apt-get update && apt-get install -y git python3 python3-pip bash curl wget && rm -rf /var/lib/apt/lists/*
RUN ln -sf /usr/bin/python3 /usr/bin/python
RUN mkdir -p /logs
RUN apt-get update && apt-get install -y python3-venv python3-dev && rm -rf /var/lib/apt/lists/*
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# The WORKDIR should always be /app
WORKDIR /app

# --- Task-specific system packages go here, merged into one apt line, e.g.:
# xz-utils unpacks the Node.js tarball installed in the next step.
RUN apt-get update && apt-get install -y xz-utils && rm -rf /var/lib/apt/lists/*

# --- Task-specific toolchain: Node.js. Ubuntu 24.04 ships Node 18, too old for this
#     repo (its release workflow uses 24.x), so the official build is installed from the
#     pinned tarball and checked against the published SHA-256 from
#     https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt.
#     Harbor builds amd64; the arm64 digest is here so the image can also be built
#     natively on an Apple Silicon machine for a quick local check.
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_AMD64=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG NODE_SHA256_ARM64=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) node_arch=x64;   node_sha="${NODE_SHA256_AMD64}" ;; \
      arm64) node_arch=arm64; node_sha="${NODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"; \
    echo "${node_sha}  ${tarball}" | sha256sum -c -; \
    tar -xJf "${tarball}" -C /usr/local --strip-components=1 --no-same-owner \
        --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    rm "${tarball}"; \
    node --version; \
    npm --version

# --- The Node equivalent of the template's requirements.txt step: the lockfile is copied
#     on its own so `npm ci` is cached until it changes, and the dependencies are baked
#     into the image so the task needs no network at run time.
#
#     ONNXRUNTIME_NODE_INSTALL=skip: onnxruntime-node's postinstall otherwise downloads
#     the CUDA 12 / TensorRT execution-provider libraries (hundreds of MB) on linux/x64.
#     The plugin only ever runs onnxruntime-web, inside Obsidian's worker, so they are
#     dead weight here; the native bindings that ship inside the package stay in place.
#     (npm >= 11.19 blocks dependency lifecycle scripts by default, which already skips
#     it; the env var keeps the behaviour explicit and covers an older NODE_VERSION.
#     Nothing in this dependency graph needs its install scripts: esbuild and sharp
#     resolve their binaries from per-platform packages in the lockfile.)
ENV ONNXRUNTIME_NODE_INSTALL=skip \
    npm_config_fund=false \
    npm_config_audit=false
COPY --from=source /src/package.json /src/package-lock.json /src/.npmrc ./
RUN npm ci

# Copies the codebase contents of the task into the working folder in the container
COPY --from=source /src/ .

# Provenance of the starting state, kept outside /app so it cannot show up in patch.diff.
COPY --from=source /build-commit /opt/task-base-commit

# Inject the build-artifact .gitignore so those files stay out of the captured
# patch.diff.
COPY gitignore /tmp/harbor.gitignore
RUN cat /tmp/harbor.gitignore >> .gitignore && rm /tmp/harbor.gitignore

# Checkpoint the starting state as tag v0.1.0-init (test.sh diffs against it).
# Steps are ';'-separated (the commit may no-op) so the tag lands whether or not
# git was already initialized and whether or not the tree has uncommitted changes.
RUN git config --global user.email "eval@bench"; \
    git config --global user.name "Eval Runner"; \
    git init; \
    git add -A; \
    git commit -m "initialize repo" || true; \
    git tag v0.1.0-init
CMD ["bash"]
