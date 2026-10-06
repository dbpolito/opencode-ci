//! Fluid CI diagrams with readable terminal details, inspired by Psychopomp's 2password film.
use std::{fs, path::PathBuf};

use anyhow::{Result, ensure};
use psychopomp::{
    at,
    author::{PlanBuilder, seconds},
    narration::{NarrationClip, Reading},
    plan::{MediaPlan, MediaRolePlan, ReelPlan, ScenePlan},
    score::{Beat, Caption, Stage, Terminal},
    sfx,
    stage::{StageElement, StagePlan, StagePost},
    terminal::TerminalPlan,
    tone::Tone,
    transcript::{Transcript, WordTiming},
};
use psychopomp_media::{Media, Voice};
use serde::Deserialize;

#[derive(Deserialize)]
struct ScriptClip {
    id: String,
    text: String,
}

const SECTIONS: [(&str, &[&str]); 5] = [
    ("intro", &["coding agent", "Meet", "pipeline"]),
    (
        "setup",
        &[
            "sign in",
            "OAuth",
            "tokens refresh",
            "next run",
            "dedicated login",
        ],
    ),
    (
        "agents",
        &[
            "two subagents",
            "Tests",
            "Security",
            "steps",
            "replies",
            "label",
            "overlaps",
        ],
    ),
    (
        "run",
        &[
            "project commands",
            "Slash review",
            "installed skill",
            "Humanizer",
            "required skill is missing",
            "run fails",
        ],
    ),
    (
        "finish",
        &[
            "full pull request review example",
            "Pick a job",
            "Let it run",
        ],
    ),
];

fn script() -> Result<Vec<ScriptClip>> {
    let clips: Vec<ScriptClip> = serde_json::from_str(include_str!("../script.json"))?;
    ensure!(
        clips.len() == SECTIONS.len(),
        "expected five narration clips"
    );
    for (clip, (id, anchors)) in clips.iter().zip(SECTIONS) {
        ensure!(clip.id == id, "expected clip {id}, got {}", clip.id);
        let text = clip.text.to_lowercase();
        for anchor in anchors {
            ensure!(
                text.contains(&anchor.to_lowercase()),
                "{id}: missing anchor '{anchor}'"
            );
        }
    }
    Ok(clips)
}

fn stage_plan() -> StagePlan {
    StagePlan {
        post: StagePost {
            bloom: 0.08,
            grain: 0.004,
            ..StagePost::RESTRAINED
        },
        elements: vec![
            StageElement::Icon {
                id: "runner".into(),
                at: [960.0, 530.0, 0.0],
                size: 152.0,
                icon: "git-branch".into(),
                path: String::new(),
                view: 256.0,
                ink: None,
                tone: Tone::Accent,
            },
            StageElement::label(
                "runner-name",
                [960.0, 670.0, 0.0],
                28.0,
                &[("opencode-ci", Tone::Accent)],
            ),
            StageElement::card("job", [300.0, 530.0, 0.0], [340.0, 124.0], "CI job").statuses(&[
                ("queued", Tone::Muted),
                ("starting", Tone::Request),
                ("running ✓", Tone::Success),
            ]),
            StageElement::card("local", [300.0, 285.0, 0.0], [320.0, 110.0], "local login")
                .statuses(&[("kept separate", Tone::Muted)]),
            StageElement::card(
                "login",
                [960.0, 250.0, -40.0],
                [350.0, 116.0],
                "ChatGPT Plus / Pro",
            )
            .statuses(&[
                ("dedicated CI login", Tone::Muted),
                ("OAuth connected ✓", Tone::Success),
            ]),
            StageElement::card("next", [1620.0, 530.0, 0.0], [310.0, 124.0], "next run").statuses(
                &[
                    ("waiting", Tone::Muted),
                    ("updated auth saved ✓", Tone::Success),
                ],
            ),
            StageElement::card("tests", [560.0, 800.0, 0.0], [330.0, 120.0], "child agent")
                .statuses(&[
                    ("running…", Tone::Muted),
                    ("test reviewer", Tone::Request),
                    ("timeout cases reviewed ✓", Tone::Success),
                ]),
            StageElement::card(
                "security",
                [1360.0, 800.0, 0.0],
                [330.0, 120.0],
                "child agent",
            )
            .statuses(&[
                ("running…", Tone::Muted),
                ("security reviewer", Tone::Warning),
                ("auth handling reviewed ✓", Tone::Success),
            ]),
            StageElement::card("command", [300.0, 280.0, -30.0], [340.0, 120.0], "/review")
                .statuses(&[("project-defined command", Tone::Request)]),
            StageElement::card(
                "skill",
                [1620.0, 280.0, -30.0],
                [350.0, 120.0],
                "--skill=humanizer",
            )
            .statuses(&[
                ("installed skill", Tone::Accent),
                ("loaded explicitly ✓", Tone::Success),
            ]),
            StageElement::card(
                "missing",
                [1620.0, 800.0, 0.0],
                [340.0, 120.0],
                "--skill=missing",
            )
            .statuses(&[
                ("required skill not found", Tone::Warning),
                ("run failed", Tone::Error),
            ])
            .tone(Tone::Warning),
            StageElement::beam("job-link", "job", "runner"),
            StageElement::beam("login-link", "login", "runner"),
            StageElement::beam("save-link", "runner", "next"),
            StageElement::beam("tests-link", "runner", "tests").tone(Tone::Request),
            StageElement::beam("security-link", "runner", "security").tone(Tone::Warning),
            StageElement::beam("command-link", "command", "runner").tone(Tone::Request),
            StageElement::beam("skill-link", "skill", "runner").tone(Tone::Accent),
            StageElement::packet("job-packet", "job-link").labeled("run"),
            StageElement::packet("progress", "job-link")
                .reversed()
                .labeled("output"),
            StageElement::packet("oauth", "login-link").labeled("OAuth"),
            StageElement::packet("save", "save-link")
                .labeled("refreshed tokens")
                .tone(Tone::Success),
            StageElement::packet("reuse", "save-link")
                .reversed()
                .labeled("updated auth")
                .tone(Tone::Success),
            StageElement::packet("test-task", "tests-link").tone(Tone::Request),
            StageElement::packet("security-task", "security-link").tone(Tone::Warning),
            StageElement::packet("test-reply", "tests-link")
                .reversed()
                .tone(Tone::Request),
            StageElement::packet("security-reply", "security-link")
                .reversed()
                .tone(Tone::Warning),
            StageElement::packet("command-packet", "command-link"),
            StageElement::packet("skill-packet", "skill-link"),
            StageElement::label(
                "title",
                [960.0, -480.0, 0.0],
                110.0,
                &[("opencode-ci", Tone::Accent)],
            ),
            StageElement::label(
                "tagline",
                [960.0, -360.0, 0.0],
                32.0,
                &[("OpenCode, better in CI", Tone::Plain)],
            ),
            StageElement::label(
                "install",
                [960.0, -250.0, 0.0],
                30.0,
                &[(
                    "$ npx opencode-ci run 'Review this repository'",
                    Tone::Plain,
                )],
            ),
            StageElement::label(
                "url",
                [960.0, -180.0, 0.0],
                28.0,
                &[("github.com/dbpolito/opencode-ci", Tone::Accent)],
            ),
        ],
    }
}

fn film(clips: [&NarrationClip; 5]) -> Result<ScenePlan> {
    let reading = Reading::new(
        seconds(0.6),
        [
            (clips[0], seconds(0.5)),
            (clips[1], seconds(0.6)),
            (clips[2], seconds(3.0)),
            (clips[3], seconds(0.6)),
            (clips[4], seconds(4.0)),
        ],
    );
    let mut scene = PlanBuilder::new("opencode-ci-better-ci", reading.duration());
    let [intro, auth, agents, workflow, finish] = reading.place(&mut scene);
    let stage = Stage::declare(&mut scene, "stage", &stage_plan())?;
    let camera = stage.camera();
    let header = Caption::header(&mut scene, "opencode-ci", "OpenCode, better in CI")?;
    // Introduce the product immediately, then build the job around it.
    at!(scene, 0 => stage.channel("runner.y", 24.0), stage.channel("runner.scale", 0.92));
    at!(scene, seconds(0.12) => header.show(), camera.establish(90.0, 1.4));
    at!(scene, seconds(0.16) => stage.fade_in("runner", 1.0, 0.6),
        stage.glide("runner.y", 0.0, 1.2), stage.glide("runner.scale", 1.0, 1.2));
    at!(scene, intro.at("Meet") => stage.type_in("runner-name", 40.0),
        stage.glide("camera.x", -30.0, 2.8), stage.to("camera.z", 0.0, 2.8),
        sfx::TICK.beat("meet", -22.0));
    let job_wired = at!(scene, intro.at("coding agent").saturating_sub(seconds(1.0)) =>
        stage.settle_in("job").then(stage.swap_status("job", [0, 1], 0.25))
        .then(stage.connect("job-link", 0.55)));
    let agent_called = at!(scene, intro.at("coding agent").max(job_wired.end) => stage.send("job-packet", 0.75)
        .with(sfx::SEND.beat("ci-job-send", -20.0))
        .then(stage.land("runner")).then(stage.swap_status("job", [1, 2], 0.3)));
    at!(scene, intro.at("pipeline").max(agent_called.end) => stage.send("progress", 0.65)
        .then(stage.land("job")).then(sfx::TICK.beat("first-output", -24.0)));

    // The subscription joins the running job; refreshed auth travels out,
    // then returns from the next-run card to show what is reused.
    let login_wired = at!(scene, auth.start() => stage.settle_in("login")
        .then(stage.connect("login-link", 0.5)));
    at!(scene, auth.start() => stage.glide("camera.y", -30.0, 1.2), stage.to("camera.z", 0.0, 1.2));
    let signed_in = at!(scene, auth.at("sign in").max(login_wired.end) => stage.send("oauth", 0.65)
        .with(sfx::SEND.beat("oauth-send", -20.0))
        .then(stage.land("runner")),
        stage.glide("camera.x", 70.0, 1.2));
    at!(scene, auth.at("OAuth").max(signed_in.end) => stage.swap_status("login", [0, 1], 0.3),
        stage.glide("camera.y", -55.0, 1.2));
    let next_ready =
        at!(scene, auth.at("dedicated login") => stage.settle_in("local"), stage.settle_in("next"));
    let tokens_saved = at!(scene, auth.at("tokens refresh").max(next_ready.end) =>
        stage.connect("save-link", 0.5).then(stage.send("save", 0.7))
        .then(stage.land("next")).then(stage.swap_status("next", [0, 1], 0.3))
        .then(sfx::CONFIRM.beat("tokens-saved", -22.0)),
        stage.glide("camera.x", -20.0, 1.4), stage.glide("camera.y", 0.0, 1.4), stage.fade_out("local", 0.7));
    at!(scene, auth.at("next run").max(tokens_saved.end + seconds(0.12)) => stage.send("reuse", 0.65)
        .then(stage.land("runner")).then(sfx::TICK.beat("auth-reused", -23.0)));
    let safety = Caption::footer(
        &mut scene,
        "safety",
        &[(
            "dedicated CI login · trusted code only · GitHub secret write-back needs a scoped PAT",
            Tone::Muted,
        )],
    )?;
    at!(scene, auth.at("dedicated login") => safety.show());

    // Slide the same diagram left to make room for readable logs. Connections
    // stay attached while the icon and child-agent cards change their layout.
    let logs = Terminal::declare(
        &mut scene,
        "agent-logs",
        TerminalPlan::new([1020.0, 255.0], 780.0, 11)
            .size(24.0)
            .titled("subagent steps + replies"),
    )?;
    let commands = Terminal::declare(
        &mut scene,
        "workflow-terminal",
        TerminalPlan::new([1020.0, 255.0], 780.0, 11)
            .size(24.0)
            .titled("project commands + installed skills"),
    )?;
    at!(scene, agents.start() => safety.hide(),
        stage.glide("runner.x", -340.0, 1.3), stage.glide("runner-name.x", -340.0, 1.3),
        stage.to("camera.z", 0.0, 1.3), stage.glide("camera.x", 0.0, 1.3));
    // x offsets are independent of each card's calibrated entrance motion.
    at!(scene, 0 => stage.channel("tests.x", -180.0), stage.channel("security.x", -560.0),
        stage.channel("skill.x", -840.0), stage.channel("missing.x", -1000.0));
    for element in ["login", "local", "next", "login-link", "save-link"] {
        at!(scene, agents.start() => stage.fade_out(element, 0.7));
    }
    let tests_started = at!(scene, agents.at("Tests") => stage.settle_in("tests")
        .then(stage.connect("tests-link", 0.4)).then(stage.send("test-task", 0.6))
        .then(stage.land("tests")).then(stage.swap_status("tests", [0, 1], 0.3)));
    let security_started = at!(scene, agents.at("Security") => stage.settle_in("security")
        .then(stage.connect("security-link", 0.4)).then(stage.send("security-task", 0.6))
        .then(stage.land("security")).then(stage.swap_status("security", [0, 1], 0.3)));
    let logs_shown = at!(scene, agents.at("steps").max(tests_started.end).max(security_started.end) => logs.show());
    at!(scene, agents.at("steps").max(logs_shown.end) => logs.print_text("[tests] Read test/runner.test.ts", Tone::Request)
        .then(logs.print_text("[security] Read src/auth.ts", Tone::Warning)));
    at!(scene, agents.at("label").max(logs_shown.end) => logs.print_text("[tests] Checking timeout coverage", Tone::Request)
        .then(logs.print_text("[security] Checking auth handling", Tone::Warning)));
    let test_reply = at!(scene, agents.at("overlaps") => stage.send("test-reply", 0.75)
        .then(stage.land("runner")).then(stage.swap_status("tests", [1, 2], 0.3)));
    let security_reply = at!(scene, test_reply.start + seconds(0.18) => stage.send("security-reply", 0.75)
        .then(stage.land("runner")).then(stage.swap_status("security", [1, 2], 0.3)));
    at!(scene, test_reply.end => logs.print_text("[tests] Reply: timeout cases reviewed", Tone::Request));
    at!(scene, security_reply.end => logs.print_text("[security] Reply: auth reviewed", Tone::Warning),
        sfx::MARK.beat("children-done", -23.0));
    at!(scene, security_reply.end + seconds(1.2) => logs.hide());

    // Quiet the earlier beat before plugging in the project's own workflow.
    for element in [
        "tests",
        "security",
        "login",
        "next",
        "tests-link",
        "security-link",
        "login-link",
        "save-link",
    ] {
        at!(scene, workflow.start() => stage.fade_out(element, 0.6));
    }
    let command_wired = at!(scene, workflow.at("project commands") => stage.to("camera.z", 0.0, 1.2),
        commands.show(), stage.settle_in("command").then(stage.connect("command-link", 0.5)));
    at!(scene, workflow.at("Slash review").max(command_wired.end) => stage.send("command-packet", 0.7)
        .with(sfx::SEND.beat("command-send", -22.0)).then(stage.land("runner")),
        commands.type_at("npx opencode-ci run \\", 70.0)
        .then(commands.print_text("  '/review the changed tests'", Tone::Request)));
    let skill_wired = at!(scene, workflow.at("installed skill") => stage.settle_in("skill").then(stage.connect("skill-link", 0.5)));
    at!(scene, workflow.at("Humanizer").max(skill_wired.end) => stage.send("skill-packet", 0.7)
        .then(stage.land("runner")).then(stage.swap_status("skill", [0, 1], 0.3))
        .then(sfx::CONFIRM.beat("skill-loaded", -23.0)),
        commands.type_at("npx opencode-ci run --skill=humanizer \\", 70.0)
        .then(commands.print_text("  'Rewrite the release notes'", Tone::Accent)));
    let missing_shown =
        at!(scene, workflow.at("required skill is missing") => stage.settle_in("missing"));
    at!(scene, workflow.at("run fails").max(missing_shown.end) => stage.swap_status("missing", [0, 1], 0.2),
        sfx::TICK.beat("missing-skill", -24.0));
    at!(scene, workflow.end() => stage.fade_out("missing", 0.5));

    // Brief recap, one included example, then one continuous flight to the title.
    at!(scene, finish.start() => commands.hide(),
        stage.glide("runner.x", 0.0, 1.5), stage.glide("runner-name.x", 0.0, 1.5),
        stage.glide("tests.x", 0.0, 1.5), stage.glide("security.x", 0.0, 1.5),
        stage.glide("skill.x", 0.0, 1.5));
    at!(scene, finish.start() => stage.fade_in("login", 1.0, 0.6), stage.to("camera.z", -110.0, 1.3));
    at!(scene, finish.start() + seconds(0.2) => stage.fade_in("tests", 1.0, 0.6), stage.fade_in("security", 1.0, 0.6));
    let example = Caption::footer(
        &mut scene,
        "example",
        &[(
            "full PR review workflow included · --skill=review-pr",
            Tone::Muted,
        )],
    )?;
    at!(scene, finish.at("full pull request review example") => example.show());
    let rise = finish.at("Pick a job");
    for element in [
        "job", "local", "login", "next", "tests", "security", "command", "skill",
    ] {
        at!(scene, rise => stage.fade_out(element, 0.6));
    }
    at!(scene, rise => header.hide(), example.hide(),
        stage.glide("camera.y", -900.0, 2.4), stage.to("camera.z", 0.0, 2.0),
        stage.glide("runner.y", -560.0, 2.4), stage.glide("runner-name.y", -560.0, 2.4),
        stage.fade_out("job-link", 0.5), stage.fade_out("command-link", 0.5), stage.fade_out("skill-link", 0.5),
        stage.fade_in("title", 1.0, 0.5), stage.fade_in("tagline", 1.0, 0.7),
        sfx::TICK.beat("title-flight", -24.0));
    at!(scene, finish.at("Let it run") => stage.type_in("install", 70.0)
        .then(stage.type_in("url", 65.0)).with(sfx::CONFIRM.beat("end-title", -20.0)));
    for (id, spoken) in ["intro", "oauth", "subagents", "workflow", "outro"]
        .iter()
        .zip([intro, auth, agents, workflow, finish])
    {
        scene.cue(*id, spoken.start(), spoken.end());
    }
    Ok(scene.finish()?)
}

/// Approximate word timings for layout checks only. No audio or API access.
fn layout_clips(script: &[ScriptClip]) -> Result<Vec<NarrationClip>> {
    script
        .iter()
        .map(|clip| {
            let words: Vec<_> = clip
                .text
                .split_whitespace()
                .enumerate()
                .map(|(index, word)| WordTiming {
                    word: word.into(),
                    start: index as f64 * 0.4,
                    end: (index + 1) as f64 * 0.4,
                })
                .collect();
            Ok(NarrationClip::new(
                &clip.id,
                "layout-placeholder.mp3",
                seconds(words.len() as f64 * 0.4),
                Transcript::new(words)?,
            ))
        })
        .collect()
}

fn main() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script = script()?;
    let motion_preview = std::env::args().any(|arg| arg == "--motion-preview");
    let preview = motion_preview || std::env::args().any(|arg| arg == "--layout-preview");
    let output = std::env::args()
        .skip(1)
        .find(|arg| arg != "--layout-preview" && arg != "--motion-preview")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            root.join(if motion_preview {
                "../../target/opencode-ci-motion.json"
            } else if preview {
                "../../target/opencode-ci-layout.json"
            } else {
                "opencode-ci.plan.json"
            })
        });
    if preview {
        let clips = layout_clips(&script)?;
        let plan = film([&clips[0], &clips[1], &clips[2], &clips[3], &clips[4]])?;
        // A short motion study can play the existing sound effects without
        // synthesizing narration. Rebase their paths against the scene root.
        let plan = if motion_preview {
            ScenePlan {
                media: plan
                    .media
                    .iter()
                    .filter(|media| matches!(media.role, MediaRolePlan::Layer))
                    .map(|media| MediaPlan {
                        path: root.join(&media.path),
                        ..media.clone()
                    })
                    .collect(),
                ..plan
            }
        } else {
            plan
        };
        let reel = ReelPlan::dipped("opencode-ci", vec![plan], 0)?;
        fs::write(output, serde_json::to_string_pretty(&reel)?)?;
        return Ok(());
    }
    let media = Media::open(&root)?;
    let voice = Voice::eleven(
        std::env::var("ELEVENLABS_VOICE_ID").unwrap_or_else(|_| "0XgTBa0kIWYq8yduYRAo".into()),
    );
    let audio = script
        .iter()
        .map(|clip| media.say(&clip.id, &voice, clip.text.as_str()))
        .collect::<Result<Vec<_>>>()?;
    media.finish()?;
    let clips: [&NarrationClip; 5] = audio
        .iter()
        .map(|audio| audio.clip())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let reel = ReelPlan::dipped("opencode-ci", vec![film(clips)?], 0)?;
    fs::write(output, serde_json::to_string_pretty(&reel)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_has_feature_order_and_visual_anchors() {
        script().unwrap();
    }

    #[test]
    fn continuous_film_builds_without_credentials() {
        let clips = layout_clips(&script().unwrap()).unwrap();
        let plan = film([&clips[0], &clips[1], &clips[2], &clips[3], &clips[4]]).unwrap();
        assert_eq!(plan.cues.len(), 5);
        assert!(plan.actors.iter().any(|actor| actor.id == "agent-logs"));
        assert!(
            plan.actors
                .iter()
                .any(|actor| actor.id == "workflow-terminal")
        );
        assert!(plan.media.iter().any(|media| media.id == "tokens-saved"));
        assert!(plan.media.iter().any(|media| media.id == "auth-reused"));
        assert!(plan.actors.iter().all(|actor| !actor.id.contains("demo")));
        assert!(
            stage_plan()
                .elements
                .iter()
                .all(|element| !matches!(element, StageElement::Orb { .. }))
        );
    }

    #[test]
    fn opening_introduces_product_before_calling_the_agent() {
        let clips = layout_clips(&script().unwrap()).unwrap();
        let plan = film([&clips[0], &clips[1], &clips[2], &clips[3], &clips[4]]).unwrap();
        let at = |id: &str| {
            plan.media
                .iter()
                .find(|media| media.id == id)
                .unwrap()
                .timeline_start_nanos
        };
        assert!(
            script().unwrap()[0]
                .text
                .starts_with("Meet Open Code see eye.")
        );
        assert!(at("meet") < seconds(1.0));
        assert!(at("meet") < at("ci-job-send"));
        assert!(plan.media.iter().all(|media| media.id != "commit-send"));
        assert!(at("ci-job-send") < at("first-output"));
    }
}
