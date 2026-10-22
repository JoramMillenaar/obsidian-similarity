/**
 * Puts note scores on one scale. Precise (the best of n·m passage pairs) and average (the mean of
 * the same pairs) both drift with note length; correcting each against the model's null
 * distribution F of passage-pair similarity removes that drift, so one tier threshold means the
 * same for both modes and for every note length.
 *
 * The scale is anchored at a typical note pair (`refPairs` passage pairs): a score is the best
 * passage match such a pair would need to be just as unlikely by chance. So a typical pair in
 * precise mode keeps its raw score, and the tiers keep the meaning they had for raw scores.
 *
 * Everything here is fitted once per model on a multilingual reference corpus
 * (src/dev/calibration), never on the user's vault.
 */
export type ScoreNullModel = {
	/** The model's mean passage direction, subtracted before comparing (removes the anisotropy floor). */
	readonly mean: Float32Array | null;
	/** Top principal component of the centered passages, projected out as well. */
	readonly pc: Float32Array | null;
	/** F as (similarity, logit F) knots, both increasing; interpolated linearly, with saturating tails. */
	readonly cdf: {readonly s: readonly number[]; readonly logit: readonly number[]};
	/** Passages within a note are correlated, so n·m pairs count as (n·m)^α independent ones. */
	readonly alphaMax: number;
	readonly alphaMean: number;
	/** Passage pairs of the typical note pair the scale is anchored at (9 × 9 sentences). */
	readonly refPairs: number;
};

function segment(x: number, xs: readonly number[]): number {
	let lo = 0;
	let hi = xs.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] <= x) lo = mid;
		else hi = mid;
	}
	return lo;
}

// Beyond the table, s approaches ±1 exponentially in logit, continuing the end segment's slope,
// so even far-out scores stay below 1 and keep their order (a clamp would tie them).
function tailRate(model: ScoreNullModel, end: "lo" | "hi"): number {
	const {s, logit} = model.cdf;
	const [i, j, bound] = end === "hi" ? [s.length - 2, s.length - 1, 1 - s[s.length - 1]] : [0, 1, s[0] + 1];
	return (s[j] - s[i]) / (logit[j] - logit[i]) / bound;
}

function logitF(model: ScoreNullModel, x: number): number {
	const {s, logit} = model.cdf;
	const last = s.length - 1;
	if (x >= 1) return Infinity;
	if (x <= -1) return -Infinity;
	if (x > s[last]) return logit[last] - Math.log((1 - x) / (1 - s[last])) / tailRate(model, "hi");
	if (x < s[0]) return logit[0] + Math.log((x + 1) / (s[0] + 1)) / tailRate(model, "lo");
	const i = segment(x, s);
	return logit[i] + (x - s[i]) * (logit[i + 1] - logit[i]) / (s[i + 1] - s[i]);
}

function fromLogit(model: ScoreNullModel, l: number): number {
	const {s, logit} = model.cdf;
	const last = s.length - 1;
	if (l > logit[last]) return 1 - (1 - s[last]) * Math.exp(-(l - logit[last]) * tailRate(model, "hi"));
	if (l < logit[0]) return -1 + (s[0] + 1) * Math.exp((l - logit[0]) * tailRate(model, "lo"));
	const i = segment(l, logit);
	return s[i] + (l - logit[i]) * (s[i + 1] - s[i]) / (logit[i + 1] - logit[i]);
}

/** log(1 + e^x) without overflow. */
const softplus = (x: number) => (x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x)));

/** logit(q) from log q. */
const logitOfLog = (logQ: number) => logQ - Math.log(-Math.expm1(logQ));

/** log erfc(x) for x ≥ 0 (Numerical Recipes' erfcc: fractional error < 1.2e-7, so the log is good far into the tail). */
function logErfc(x: number): number {
	const t = 1 / (1 + 0.5 * x);
	const poly = -1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
		+ t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
	return Math.log(t) - x * x + poly;
}

/** logit Φ(z), the standard normal CDF's log-odds. */
function logitNormalCdf(z: number): number {
	// log Φ(−|z|) = log ½ erfc(|z|/√2); log Φ(|z|) = log(1 − Φ(−|z|)).
	const logLower = Math.log(0.5) + logErfc(Math.abs(z) / Math.SQRT2);
	const logit = logLower - Math.log1p(-Math.exp(logLower));
	return z < 0 ? logit : -logit;
}

/** Φ⁻¹(p) for p given as its logit (Acklam's algorithm, relative error < 1.2e-9). */
function probitOfLogit(logit: number): number {
	const logSmall = -softplus(Math.abs(logit)); // log min(p, 1 − p)
	const small = Math.exp(logSmall);
	let z: number;
	if (small < 0.02425) {
		const q = Math.sqrt(-2 * logSmall);
		z = (((((-7.784894002430293e-3 * q - 3.223964580411365e-1) * q - 2.400758277161838) * q - 2.549732539343734) * q
			+ 4.374664141464968) * q + 2.938163982698783)
			/ ((((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996) * q + 3.754408661907416) * q + 1);
	} else {
		const q = small - 0.5;
		const r = q * q;
		z = (((((-3.969683028665376e1 * r + 2.209460984245205e2) * r - 2.759285104469687e2) * r + 1.383577518672690e2) * r
			- 3.066479806614716e1) * r + 2.506628277459239) * q
			/ (((((-5.447609879822406e1 * r + 1.615858368580409e2) * r - 1.556989798598866e2) * r + 6.680131188771972e1) * r
				- 1.328068155288585e1) * r + 1);
	}
	return logit > 0 ? -z : z;
}

/** The best of `refPairs` pairs whose null probability (as log q, single-pair) is q: F⁻¹(q^(1/N_ref)). */
function anchored(model: ScoreNullModel, logQ: number): number {
	return fromLogit(model, logitOfLog(logQ / Math.pow(model.refPairs, model.alphaMax)));
}

/** Šidák: `best` as the max of `pairs` pairs is as unlikely by chance as F(best)^N, so N = N_ref keeps it. */
export function correctBest(model: ScoreNullModel, best: number, pairs: number): number {
	const n = Math.pow(pairs, model.alphaMax);
	return anchored(model, -n * softplus(-logitF(model, best))); // N · log F(best)
}

/**
 * `mean` as the mean of `pairs` pairs is as unlikely by chance as Φ(z), with z = √N · Φ⁻¹(F(mean)).
 * That is (mean − μ)/(σ/√N) wherever F is Gaussian, but stays exact at N = 1 where F is not.
 */
export function correctMean(model: ScoreNullModel, mean: number, pairs: number): number {
	const z = Math.sqrt(Math.pow(pairs, model.alphaMean)) * probitOfLogit(logitF(model, mean));
	return anchored(model, -softplus(-logitNormalCdf(z))); // log Φ(z)
}
