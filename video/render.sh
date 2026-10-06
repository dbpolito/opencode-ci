#!/usr/bin/env bash
set -euo pipefail

video_dir="$(cd "$(dirname "$0")" && pwd)"
engine="${PSYCHOPOMP_DIR:-$video_dir/.psychopomp}"
revision=a17d31587d06de0a6706d527f04212caa38a1df3

if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "Set ELEVENLABS_API_KEY before rendering. Optional: ELEVENLABS_VOICE_ID." >&2
  exit 1
fi

if [[ ! -d "$engine" ]]; then
  git clone https://github.com/kitlangton/psychopomp.git "$engine"
  git -C "$engine" checkout --detach "$revision"
fi
if [[ "$(git -C "$engine" rev-parse HEAD)" != "$revision" ]]; then
  echo "Expected Psychopomp $revision; use a separate checkout." >&2
  exit 1
fi

# The pinned upstream requests 192 kbps, restricted to Creator plans and above.
# Apply the 128 kbps compatibility patch once; do not overwrite conflicting edits.
format_patch="$video_dir/elevenlabs-format.patch"
if git -C "$engine" apply --check "$format_patch" 2>/dev/null; then
  git -C "$engine" apply "$format_patch"
elif ! git -C "$engine" apply --reverse --check "$format_patch" 2>/dev/null; then
  echo "Cannot apply ElevenLabs format fix; checkout has conflicting edits." >&2
  exit 1
fi

mkdir -p "$engine/scenes/opencode-ci/src" "$video_dir/output"
cp "$video_dir/scene/Cargo.toml" "$video_dir/scene/script.json" "$engine/scenes/opencode-ci/"
cp "$video_dir/scene/src/main.rs" "$engine/scenes/opencode-ci/src/"
cd "$engine"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
cargo run -p psychopomp-opencode-ci
cargo build --release
target/release/psychopomp plan validate scenes/opencode-ci/opencode-ci.plan.json
target/release/psychopomp plan render scenes/opencode-ci/opencode-ci.plan.json "$video_dir/output/opencode-ci.mp4" --theme opencode
python3 "$video_dir/bundle.py" scenes/opencode-ci/opencode-ci.plan.json "$video_dir/output"
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration -of json "$video_dir/output/opencode-ci.mp4"
