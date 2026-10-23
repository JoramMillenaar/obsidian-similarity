const test = require("node:test");
const assert = require("node:assert");

const {KeywordIndex, tokenize, countQueryTerms} = require("../dist/core/text/keywordIndex.js");

function indexOf(notes) {
	const index = new KeywordIndex();
	for (const [id, text] of Object.entries(notes)) index.set(id, text, `hash-${id}`);
	return index;
}

/** Filler notes, so everyday words are common and names are rare, as in a real vault. */
function filler(count) {
	const notes = {};
	for (let i = 0; i < count; i++) notes[`filler-${i}.md`] = `How does the week go ${i}? We have done many things and the day was long.`;
	return notes;
}

test("tokenize folds case and accents, keeps number sequences whole and splits CJK into bigrams", () => {
	assert.deepStrictEqual(tokenize("Matatlán 4-7-8"), ["4-7-8", "matatlan", "4", "7", "8"]);
	assert.deepStrictEqual(tokenize("テザリング"), ["テザ", "ザリ", "リン", "ング"]);
	assert.deepStrictEqual(tokenize("gpio18号"), ["gpio18", "号"]);
});

test("a rare name finds the note that contains it", () => {
	const index = indexOf({...filler(40), "tokyo.md": "Getting around: a Suica or PASMO card works on every line."});
	assert.deepStrictEqual(index.search("PASMO"), ["tokyo.md"]);
});

test("a descriptive search that only shares everyday words finds nothing", () => {
	const index = indexOf({...filler(40), "tokyo.md": "Getting around: a Suica or PASMO card works on every line."});
	assert.deepStrictEqual(index.search("how did the week go"), []);
});

test("a search with words no note contains finds nothing, even if one word matches", () => {
	const index = indexOf({...filler(40), "car.md": "Der Händler nimmt meinen alten Wagen in Zahlung."});
	assert.deepStrictEqual(index.search("Händler Gebrauchtwagenpreis Inzahlungnahme"), []);
});

test("a search word matches longer forms of itself, but not unrelated longer words", () => {
	const index = indexOf({...filler(40), "leipzig.md": "Die Wohnung liegt im dritten Stock eines Altbaus.", "card.md": "Cardiology appointment."});
	assert.deepStrictEqual(index.search("Altbau"), ["leipzig.md"]);
	assert.deepStrictEqual(index.search("card"), []);
});

test("number sequences match as one term", () => {
	const index = indexOf({...filler(40), "sleep.md": "The 4-7-8 breath helps me fall asleep.", "dates.md": "Room 4, floor 7, desk 8."});
	assert.deepStrictEqual(index.search("4-7-8"), ["sleep.md"]);
});

test("everyday words in a question neither help nor block a match", () => {
	const index = indexOf({...filler(40), "lofoten.md": "The Reinebringen hike has almost a thousand stone steps."});
	assert.deepStrictEqual(index.search("How many steps does the Reinebringen hike have?"), ["lofoten.md"]);
});

test("removing and re-setting a note updates what it is found for", () => {
	const index = indexOf({...filler(40), "a.md": "Zahnriemen wechseln"});
	assert.deepStrictEqual(index.search("Zahnriemen"), ["a.md"]);
	index.set("a.md", "Winterreifen kaufen", "hash-2");
	assert.deepStrictEqual(index.search("Zahnriemen"), []);
	assert.deepStrictEqual(index.search("Winterreifen"), ["a.md"]);
	assert.strictEqual(index.hashOf("a.md"), "hash-2");
	index.remove("a.md");
	assert.deepStrictEqual(index.search("Winterreifen"), []);
	assert.strictEqual(index.hashOf("a.md"), undefined);
});

test("countQueryTerms counts the distinct search words a passage contains", () => {
	assert.strictEqual(countQueryTerms("Stuck Altbau", "Stuck an der Decke eines Altbaus"), 2);
	assert.strictEqual(countQueryTerms("Stuck Altbau", "Ein kleiner Balkon"), 0);
});
