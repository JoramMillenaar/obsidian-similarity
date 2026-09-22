const test = require("node:test");
const assert = require("node:assert");

const {formatReport, issueUrl, mailtoUrl, reportTitle} = require("../dist/core/feedback.js");

const ENVIRONMENT = {
	pluginVersion: "2.6.1",
	obsidianVersion: "1.13.1",
	platform: "desktop macOS",
	userAgent: "Mozilla/5.0 (test)",
	cpuCores: 8,
	memoryGb: 16,
	webgpuAvailable: true,
	engineState: "ready",
	modelId: "xenova-all-MiniLM-L6-v2",
	device: "webgpu",
	indexedNotes: 1240,
	searchMode: "granular",
	maxRawMarkdownChars: 20000,
	maxExtractedChars: 4800,
	maxOverlapPercent: 15,
};

test("bug and feedback reports are titled after the first line of the description", () => {
	assert.strictEqual(
		reportTitle({kind: "bug", description: "Sidebar stays empty\nafter switching models"}),
		"[Bug] Sidebar stays empty",
	);
	assert.strictEqual(reportTitle({kind: "feedback", description: ""}), "[Feedback]");
});

test("environment is only included when present and never lists vault paths", () => {
	const body = formatReport({kind: "bug", description: "It broke", environment: ENVIRONMENT});

	assert.match(body, /Similarity 2\.6\.1 · Obsidian 1\.13\.1 · desktop macOS/);
	assert.match(body, /Model: xenova-all-MiniLM-L6-v2 \(ready, webgpu\) · 1240 notes indexed/);
	assert.match(body, /Search mode: granular · limits 20000\/4800\/15%/);
	assert.match(body, /8 cores, 16 GB, WebGPU available/);
	assert.doesNotMatch(body, /ignoredPaths|\.md/);
});

test("missing hardware fields are skipped rather than printed as undefined", () => {
	const body = formatReport({
		kind: "bug",
		description: "x",
		environment: {...ENVIRONMENT, cpuCores: undefined, memoryGb: undefined, webgpuAvailable: false, device: undefined, modelId: undefined, engineState: "idle"},
	});

	assert.match(body, /Hardware: no WebGPU\n/);
	assert.match(body, /Model: idle · /);
	assert.doesNotMatch(body, /undefined/);
});

test("long descriptions are truncated to stay inside URL limits", () => {
	const report = {kind: "bug", description: "y".repeat(10_000)};

	const body = formatReport(report);
	assert.ok(body.length <= 6000, `body was ${body.length} chars`);
	assert.ok(reportTitle(report).length <= 120);
	assert.ok(issueUrl(report, "https://example.com/repo").length < 12_000);
});

test("issue and mailto URLs encode the report and point at the right destination", () => {
	const report = {kind: "feedback", description: "Love it & want more\nsecond line"};

	const issue = issueUrl(report, "https://github.com/o/r");
	assert.ok(issue.startsWith("https://github.com/o/r/issues/new?title=%5BFeedback%5D%20Love%20it%20%26%20want%20more&body="));
	assert.match(issue, /more%0Asecond%20line$/);

	const mail = mailtoUrl(report, "me@example.com");
	assert.ok(mail.startsWith("mailto:me@example.com?subject=%5BFeedback%5D%20Love%20it%20%26%20want%20more&body="));
	assert.match(mail, /more%0D%0Asecond%20line$/);
});
