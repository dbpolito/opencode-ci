# OpenCode CI launch video

A short, 1920×1080, 60 fps Psychopomp film built around “OpenCode, better in CI”: OAuth subscriptions, subagent logs, and project commands/skills. It opens with “Meet OpenCode CI” and the workflow icon, then explains the product as a job connects to the agent and output travels back. OAuth joins the running diagram; refreshed credentials travel to the next-run card and back. Conversational narration follows those events rather than listing features. A workflow/branch icon replaces the particle orb. The diagram smoothly moves left to make room for readable terminals showing subagent output and CLI commands, then returns for the closing title. Motion uses minimum-jerk glides, restrained entrances, and quiet sound cues; no rewind, shake, or glitch effects. Narration uses ElevenLabs; duration follows the generated audio. Editable narration is in `scene/script.json`; choreography is in `scene/src/main.rs`.

## Render

On macOS, install Rust, Python 3 (for bundling assets), and FFmpeg with libx264. Then run from the repository root:

```sh
ELEVENLABS_API_KEY=your-key-here video/render.sh
```

The default voice ID is `0XgTBa0kIWYq8yduYRAo`, using Psychopomp's default `eleven_v4` model and provider word alignment. To choose another voice, also set `ELEVENLABS_VOICE_ID` to its voice ID. Rendering uses paid ElevenLabs credits for new or changed narration; unchanged clips are cached. No OpenCode or OpenAI credentials are needed to make the video.

For a key kept out of shell history, you can instead put `ELEVENLABS_API_KEY=...` (and optionally `ELEVENLABS_VOICE_ID=...`) in ignored `video/.env`, then load it:

```sh
set -a
source video/.env
set +a
video/render.sh
```

The script clones a pinned Psychopomp revision into ignored `video/.psychopomp`, installs our scene into its workspace, generates narration, validates the plan, and renders `video/output/opencode-ci.mp4`. `bundle.py` also copies the narration and built-in sound effects alongside the plan, rewriting engine-relative audio paths so the output bundle stands alone. Sound effects use the engine's existing assets, with no extra generation charges. An existing checkout at the pinned revision can be supplied with `PSYCHOPOMP_DIR`.

The script applies `elevenlabs-format.patch` to request `mp3_44100_128` rather than upstream's Creator-tier-only `mp3_44100_192`. The format is part of the media cache key, so cached audio correctly follows the changed request. Repeated runs do not reapply the patch; conflicting local edits fail without being overwritten.

## Story and fact sources

| Section | Visual | Source |
| --- | --- | --- |
| Intro | Meet OpenCode CI → job connects → agent runs → output returns | `README.md`, CI runner |
| OAuth | Login → CI run → refreshed tokens saved for next run | `README.md`, `docs/github-actions.md` |
| Agents | Two child-agent cards with labeled steps and replies in an adjacent terminal | `README.md`, subagent output |
| Workflow | `/review` and `--skill=humanizer` send requests; a missing skill fails | `README.md`, commands and skills |
| Finish | Brief included PR review example; smooth return and closing title | `README.md`, `.github/workflows/opencode-review-pr.yml` |

The visuals are choreographed explanations, not a live agent recording. There are no "illustrated demo" labels in the film. Commands are displayed only, never executed. The `/review` example assumes a project-defined command; the humanizer example assumes that skill is installed. No auth files are read. The PR review workflow is one included example, not the product's central feature. Review publishing requires the installed review skill, authenticated `gh`, and appropriate permissions; saving GitHub secrets requires a scoped PAT. The video assumes trusted PR code and a separate CI credential.

Visual reference: [Kit Langton's 2password post](https://x.com/kitlangton/status/2106481559176196140) and [`scenes/2password`](https://github.com/kitlangton/psychopomp/tree/main/scenes/2password). The choreography keeps its persistent Stage, causal sends and landings, and closing camera rise, with readable terminal surfaces from the first cut. The script and story are specific to OpenCode CI.

Keep the phrase anchors in `main.rs` aligned with the transcript when editing narration. Narration is generated and cached by Psychopomp's media reconciler; timings and film duration follow the audio.

## Verification status

`output/opencode-ci.mp4` shows an earlier cut until you render again. `output/opening-motion.mp4` is a 26-second motion study of the previous git-push opening with existing sound effects, approximate word timings, and no narration. This revision has not been voiced or rendered as a full video; no paid API requests were made while editing it. Changed narration clips will be regenerated on your next render. The only engine change remains the output-format compatibility patch and its cache-key test expectations.

Layout is checked with approximate word timings, without generating audio:

```sh
# After the render script has copied the source into the engine:
cd video/.psychopomp
cargo run -p psychopomp-opencode-ci -- --layout-preview
# Then use plan frame/snapshot on target/opencode-ci-layout.json.
```

This mode is for still-frame review only; its placeholder audio does not exist. `--motion-preview` instead omits narration and resolves existing sound-effect paths, producing `target/opencode-ci-motion.json` for a no-API motion render. The normal render uses actual ElevenLabs timings. Existing preview images predate the latest opening and narration changes. Review actual timing and sound after your render.

Scene tests, Clippy, formatting, shell syntax, plan validation, and the audio-bundle unit test passed. Frames from every section were inspected with motion-blur sampling; they do not prove normal-speed timing or audio balance. No full video or normal-speed playback review was performed for this revision.
