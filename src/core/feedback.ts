import { SearchMode } from "../types";

export type FeedbackKind = "bug" | "feedback";

export type DeviceInfo = {
	pluginVersion: string;
	obsidianVersion: string;
	platform: string;
	userAgent: string;
	cpuCores?: number;
	memoryGb?: number;
	webgpuAvailable: boolean;
};

export type EnvironmentInfo = DeviceInfo & {
	engineState: string;
	modelId?: string;
	device?: string;
	indexedNotes: number;
	searchMode: SearchMode;
	maxRawMarkdownChars: number;
	maxExtractedChars: number;
	maxOverlapPercent: number;
};

export type FeedbackReport = {
	kind: FeedbackKind;
	description: string;
	environment?: EnvironmentInfo;
};

const TITLE_PREFIX: Record<FeedbackKind, string> = {
	bug: "[Bug]",
	feedback: "[Feedback]",
};

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 6000;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function reportTitle(report: FeedbackReport): string {
	const prefix = TITLE_PREFIX[report.kind];
	const summary = report.description.split("\n")[0].trim();
	return truncate(`${prefix} ${summary}`.trim(), MAX_TITLE_CHARS);
}

function formatEnvironment(env: EnvironmentInfo): string {
	const model = env.modelId ? `${env.modelId} (${env.engineState}${env.device ? `, ${env.device}` : ""})` : env.engineState;
	const hardware = [
		env.cpuCores !== undefined ? `${env.cpuCores} cores` : null,
		env.memoryGb !== undefined ? `${env.memoryGb} GB` : null,
		env.webgpuAvailable ? "WebGPU available" : "no WebGPU",
	].filter(Boolean).join(", ");

	return [
		`Similarity ${env.pluginVersion} · Obsidian ${env.obsidianVersion} · ${env.platform}`,
		`Model: ${model} · ${env.indexedNotes} notes indexed`,
		`Search mode: ${env.searchMode} · limits ${env.maxRawMarkdownChars}/${env.maxExtractedChars}/${env.maxOverlapPercent}%`,
		`Hardware: ${hardware}`,
		`UA: ${env.userAgent}`,
	].join("\n");
}

export function formatReport(report: FeedbackReport): string {
	const sections: string[] = [];

	const description = report.description.trim();
	if (description) {
		sections.push(description);
	}

	if (report.environment) {
		sections.push(`**Environment**\n${formatEnvironment(report.environment)}`);
	}

	return truncate(sections.join("\n\n"), MAX_BODY_CHARS);
}

export function issueUrl(report: FeedbackReport, repoUrl: string): string {
	const title = encodeURIComponent(reportTitle(report));
	const body = encodeURIComponent(formatReport(report));
	return `${repoUrl}/issues/new?title=${title}&body=${body}`;
}

export function mailtoUrl(report: FeedbackReport, email: string): string {
	const subject = encodeURIComponent(reportTitle(report));
	// RFC 6068 wants CRLF line breaks in mailto bodies.
	const body = encodeURIComponent(formatReport(report).replace(/\n/g, "\r\n"));
	return `mailto:${email}?subject=${subject}&body=${body}`;
}
