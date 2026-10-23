const test = require("node:test");
const assert = require("node:assert");

const {passageWindow, splitWindow} = require("../dist/core/text/passageWindow.js");

// Five 10-character passages, a space apart: 0–10, 11–21, 22–32, 33–43, 44–54.
const SPANS = [0, 11, 22, 33, 44].map((start) => ({start, end: start + 10}));

test("grows the passage by whole neighbours, after then before, while it fits", () => {
	assert.deepStrictEqual(passageWindow(SPANS, SPANS[2], 32), {start: 11, end: 43});
	assert.deepStrictEqual(passageWindow(SPANS, SPANS[2], 21), {start: 22, end: 43});
	assert.deepStrictEqual(passageWindow(SPANS, SPANS[2], 1000), {start: 0, end: 54});
});

test("grows only one way at the edge of the note", () => {
	assert.deepStrictEqual(passageWindow(SPANS, SPANS[4], 32), {start: 22, end: 54});
	assert.deepStrictEqual(passageWindow(SPANS, SPANS[0], 32), {start: 0, end: 32});
});

test("a passage longer than the budget is cut, and one not among the spans is returned alone", () => {
	assert.deepStrictEqual(passageWindow(SPANS, SPANS[1], 4), {start: 11, end: 15});
	assert.deepStrictEqual(passageWindow(SPANS, {start: 5, end: 25}, 100), {start: 5, end: 25});
});

test("splits a window into pieces of whole spans that fit, in text order", () => {
	const window = {start: 0, end: 54};
	assert.deepStrictEqual(splitWindow(SPANS, window, 21), [{start: 0, end: 21}, {start: 22, end: 43}, {start: 44, end: 54}]);
	assert.deepStrictEqual(splitWindow(SPANS, window, 32), [{start: 0, end: 32}, {start: 33, end: 54}]);
	assert.deepStrictEqual(splitWindow(SPANS, {start: 11, end: 32}, 1000), [{start: 11, end: 32}]);
});

test("a span longer than a piece is a piece of its own, and one reaching past the window is cut at its edge", () => {
	assert.deepStrictEqual(splitWindow(SPANS, {start: 0, end: 21}, 5), [{start: 0, end: 10}, {start: 11, end: 21}]);
	assert.deepStrictEqual(splitWindow([{start: 0, end: 100}], {start: 0, end: 40}, 25), [{start: 0, end: 40}]);
});
